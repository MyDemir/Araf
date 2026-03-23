"use strict";

/**
 * Event Listener Worker — On-Chain ↔ MongoDB Sync Engine
 *
 * [TR] On-chain ArafEscrow event'lerini dinler ve MongoDB'ye yansıtır.
 * Checkpoint (Redis), replay, DLQ retry ve otomatik reconnect destekler.
 * [EN] Listens to on-chain ArafEscrow events and mirrors them to MongoDB.
 * Supports checkpoint (Redis), replay, DLQ retry and auto-reconnect.
 */

const { ethers }         = require("ethers");
const { getRedisClient } = require("../config/redis");
const { Trade, Listing } = require("../models/Trade");
const User               = require("../models/User");
const logger             = require("../utils/logger");

const CHECKPOINT_KEY             = "worker:last_block";
const DLQ_KEY                    = "worker:dlq";
const RETRY_DELAY_MS             = 5_000;
const MAX_RETRIES                = 3;
const BLOCK_BATCH_SIZE           = 1_000;
const CHECKPOINT_INTERVAL_BLOCKS = 50;

// [TR] Olay ciddiyetine göre ağırlıklı başarısızlık puanları
// [EN] Weighted failure scores by event severity
const FAILURE_SCORE_WEIGHTS = {
  burned:           50,
  unjust_challenge: 20,
  passive_maker:    20,
  failed_dispute:   20,
};

// [TR] queryFilter("*") yerine event bazlı filtreleme — RPC rate limit koruması
// [EN] Per-event filtering instead of queryFilter("*") — protects against RPC rate limits
const EVENT_NAMES = [
  "WalletRegistered",
  "EscrowCreated", "EscrowLocked", "PaymentReported",
  "EscrowReleased", "DisputeOpened",
  "CancelProposed", "EscrowCanceled",
  "MakerPinged", "ReputationUpdated",
  "BleedingDecayed", "EscrowBurned",
];

const ARAF_ABI = [
  "event WalletRegistered(address indexed wallet, uint256 timestamp)",
  "event EscrowCreated(uint256 indexed tradeId, address indexed maker, address token, uint256 amount, uint8 tier)",
  "event EscrowLocked(uint256 indexed tradeId, address indexed taker, uint256 takerBond)",
  "event PaymentReported(uint256 indexed tradeId, string ipfsHash, uint256 timestamp)",
  "event EscrowReleased(uint256 indexed tradeId, address indexed maker, address indexed taker, uint256 takerFee, uint256 makerFee)",
  "event DisputeOpened(uint256 indexed tradeId, address indexed challenger, uint256 timestamp)",
  "event CancelProposed(uint256 indexed tradeId, address indexed proposer)",
  "event EscrowCanceled(uint256 indexed tradeId, uint256 makerRefund, uint256 takerRefund)",
  "event MakerPinged(uint256 indexed tradeId, address indexed pinger, uint256 timestamp)",
  "event ReputationUpdated(address indexed wallet, uint256 successful, uint256 failed, uint256 bannedUntil, uint8 effectiveTier)",
  "event BleedingDecayed(uint256 indexed tradeId, uint256 decayedAmount, uint256 timestamp)",
  "event EscrowBurned(uint256 indexed tradeId, uint256 burnedAmount)",
];

class EventWorker {
  constructor() {
    this.provider  = null;
    this.contract  = null;
    this.isRunning = false;
    this._lastCheckpointBlock = 0;
  }

  async start() {
    logger.info("[Worker] Starting event listener...");
    this.isRunning = true;
    await this._connect();
    await this._replayMissedEvents();
    this._attachLiveListeners();
    logger.info("[Worker] Event listener active.");
  }

  async stop() {
    this.isRunning = false;
    if (this.provider) {
      this.provider.removeAllListeners();
    }
    logger.info("[Worker] Event listener stopped.");
  }

  async _connect() {
    const rpcUrl          = process.env.BASE_RPC_URL || "https://mainnet.base.org";
    const contractAddress = process.env.ARAF_ESCROW_ADDRESS;

    if (!contractAddress || contractAddress === "0x0000000000000000000000000000000000000000") {
      if (process.env.NODE_ENV === "production") {
        logger.error("[Worker] KRİTİK: ARAF_ESCROW_ADDRESS tanımlı değil. Sunucu durduruluyor.");
        process.exit(1);
      }
      logger.warn("[Worker] ARAF_ESCROW_ADDRESS not set. Worker in dry-run mode (development only).");
      return;
    }

    const wsRpcUrl = process.env.BASE_WS_RPC_URL;

    if (wsRpcUrl && wsRpcUrl.startsWith("wss://")) {
      try {
        this.provider = new ethers.WebSocketProvider(wsRpcUrl);
        logger.info(`[Worker] WebSocket RPC bağlantısı kuruldu: ${wsRpcUrl.split("/v2/")[0]}`);
      } catch (wsErr) {
        logger.warn(`[Worker] WebSocket başarısız, HTTP fallback: ${wsErr.message}`);
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
      }
    } else {
      this.provider = new ethers.JsonRpcProvider(rpcUrl);
      if (process.env.NODE_ENV === "production") {
        logger.warn("[Worker] ⚠ HTTP RPC kullanılıyor. Gerçek zamanlı event için BASE_WS_RPC_URL ekleyin.");
      }
    }

    this.contract = new ethers.Contract(contractAddress, ARAF_ABI, this.provider);
    logger.info(`[Worker] Connected to Base at ${wsRpcUrl || rpcUrl}`);
    logger.info(`[Worker] Watching contract: ${contractAddress}`);
  }

  // [TR] Yeniden başlatmada kaçırılan blokları checkpoint'ten itibaren işler
  // [EN] Processes missed blocks from checkpoint on restart
  async _replayMissedEvents() {
    if (!this.contract) return;

    const redis      = getRedisClient();
    const savedBlock = await redis.get(CHECKPOINT_KEY);
    const fromBlock  = savedBlock ? parseInt(savedBlock) + 1 : 0;
    const toBlock    = await this.provider.getBlockNumber();

    if (fromBlock > toBlock) {
      logger.info("[Worker] No missed events. Checkpoint is current.");
      return;
    }

    logger.info(`[Worker] Replaying events from block ${fromBlock} to ${toBlock}...`);

    for (let from = fromBlock; from <= toBlock; from += BLOCK_BATCH_SIZE) {
      const to = Math.min(from + BLOCK_BATCH_SIZE - 1, toBlock);

      const allEvents = [];
      for (const eventName of EVENT_NAMES) {
        try {
          const filtered = await this.contract.queryFilter(eventName, from, to);
          // [TR] Dönen verinin gerçekten bir liste (iterable) olduğundan emin ol (Ethers.js crash koruması)
          if (Array.isArray(filtered)) {
            allEvents.push(...filtered);
          } else {
            logger.warn(`[Worker] Replay: ${eventName} sorgusu boş/geçersiz döndü (iterable değil).`);
          }
        } catch (err) {
          logger.warn(`[Worker] Replay: ${eventName} sorgusu başarısız (blok ${from}-${to}): ${err.message}`);
        }
      }
      // [TR] Blok ve log index sırasına göre sırala — event işleme sırası önemli
      // [EN] Sort by block and log index — event processing order matters
      allEvents.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

      for (const event of allEvents) {
        await this._processEvent(event);
      }

      await this._updateCheckpointIfHigher(to);
      logger.debug(`[Worker] Replayed blocks ${from}-${to} (${allEvents.length} events)`);
    }

    this._lastCheckpointBlock = toBlock;
    logger.info("[Worker] Replay complete.");
  }

  _attachLiveListeners() {
    if (!this.contract) return;

    for (const eventName of EVENT_NAMES) {
      this.contract.on(eventName, async (...args) => {
        const event = args[args.length - 1];
        await this._processEventWithRetry(event);
        await this._updateCheckpointIfHigher(event.blockNumber);
      });
    }

    // [TR] Event olmayan bloklarda da checkpoint'i periyodik günceller
    // [EN] Periodically updates checkpoint even on blocks without events
    this.provider.on("block", async (blockNumber) => {
      if (blockNumber - this._lastCheckpointBlock >= CHECKPOINT_INTERVAL_BLOCKS) {
        await this._updateCheckpointIfHigher(blockNumber);
      }
    });

    this.provider.on("error", async (err) => {
      logger.error(`[Worker] Provider error: ${err.message}. Reconnecting...`);
      await this._reconnect();
    });
  }

  // [TR] Checkpoint'i yalnızca monoton artan şekilde günceller — geri alma riski yok
  // [EN] Updates checkpoint only if higher — prevents rollback risk
  async _updateCheckpointIfHigher(blockNumber) {
    const redis   = getRedisClient();
    const current = parseInt(await redis.get(CHECKPOINT_KEY) || "0");
    if (blockNumber > current) {
      await redis.set(CHECKPOINT_KEY, blockNumber.toString());
      this._lastCheckpointBlock = blockNumber;
    }
  }

  async _reconnect() {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    await this._connect();
    this._attachLiveListeners();
  }

  async _processEventWithRetry(event, attempt = 1) {
    try {
      await this._processEvent(event);
    } catch (err) {
      logger.error(`[Worker] Failed to process ${event.eventName} (attempt ${attempt}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        await this._processEventWithRetry(event, attempt + 1);
      } else {
        await this._addToDLQ(event, err.message);
      }
    }
  }

  // [TR] rPush: Yeni entry'ler listenin sonuna eklenir.
  //      dlqProcessor lRange(0, 9) ile baştan okur → FIFO sırası sağlanır.
  //      lPush kullanıldığında en yeni event başa gider, eski event'ler asla işlenmeyebilir.
  // [EN] rPush: New entries appended to tail.
  //      dlqProcessor reads from head with lRange(0, 9) → FIFO order guaranteed.
  //      With lPush, newest event goes to head; oldest events may never be processed.
  async _addToDLQ(event, errorMsg) {
    const redis = getRedisClient();
    const entry = JSON.stringify({
      eventName:   event.eventName,
      txHash:      event.transactionHash,
      blockNumber: event.blockNumber,
      args:        event.args?.map(a => a.toString()),
      error:       errorMsg,
      timestamp:   new Date().toISOString(),
    });
    await redis.rPush(DLQ_KEY, entry);
    logger.error(`[Worker] Event moved to DLQ: ${event.eventName} tx=${event.transactionHash}`);
  }

  async _processEvent(event) {
    const handlers = {
      WalletRegistered:  this._onWalletRegistered.bind(this),
      EscrowCreated:     this._onEscrowCreated.bind(this),
      EscrowLocked:      this._onEscrowLocked.bind(this),
      PaymentReported:   this._onPaymentReported.bind(this),
      EscrowReleased:    this._onEscrowReleased.bind(this),
      DisputeOpened:     this._onDisputeOpened.bind(this),
      CancelProposed:    this._onCancelProposed.bind(this),
      EscrowCanceled:    this._onEscrowCanceled.bind(this),
      MakerPinged:       this._onMakerPinged.bind(this),
      ReputationUpdated: this._onReputationUpdated.bind(this),
      BleedingDecayed:   this._onBleedingDecayed.bind(this),
      EscrowBurned:      this._onEscrowBurned.bind(this),
    };

    const handler = handlers[event.eventName];
    if (handler) {
      await handler(event);
      logger.debug(`[Worker] Processed: ${event.eventName} tx=${event.transactionHash}`);
    }
  }

  // ─── Event Handler'ları / Event Handlers ─────────────────────────────────

  async _onWalletRegistered(event) {
    const { wallet } = event.args;
    await User.findOneAndUpdate(
      { wallet_address: wallet.toLowerCase() },
      { $setOnInsert: { wallet_address: wallet.toLowerCase() } },
      { upsert: true }
    );
    logger.info(`[Worker] Wallet registered on-chain: ${wallet.toLowerCase()}`);
  }

  async _onEscrowCreated(event) {
    const { tradeId, maker, amount, tier } = event.args;
    let listing = await Listing.findOne({ onchain_escrow_id: Number(tradeId) }).lean();

    if (!listing) {
      // [TR] Maker'ın on-chain ID'si atanmamış en son ilanıyla eşleştir
      // [EN] Match to maker's most recent listing without an on-chain ID
      listing = await Listing.findOne({
        maker_address: maker.toLowerCase(),
        onchain_escrow_id: null,
      }).sort({ _id: -1 }).lean();

      if (listing) {
        await Listing.updateOne(
          { _id: listing._id },
          { $set: { onchain_escrow_id: Number(tradeId), status: "OPEN" } }
        );
      } else {
        logger.warn(`[Worker] EscrowCreated: Trade #${tradeId} için kaynak ilan bulunamadı.`);
      }
    }

    const financials = listing
      ? {
          crypto_amount: Number(amount),
          exchange_rate: listing.exchange_rate,
          crypto_asset:  listing.crypto_asset,
          fiat_currency: listing.fiat_currency,
        }
      : { crypto_amount: Number(amount), exchange_rate: 0, crypto_asset: "USDT", fiat_currency: "TRY" };

    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      {
        $setOnInsert: {
          onchain_escrow_id: Number(tradeId),
          listing_id:        listing ? listing._id : null,
          maker_address:     maker.toLowerCase(),
          status:            "OPEN",
          tier:              Number(tier),
          financials,
        },
      },
      { upsert: true }
    );
  }

  async _onEscrowLocked(event) {
    const { tradeId, taker } = event.args;
    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      {
        $set: {
          status:             "LOCKED",
          taker_address:      taker.toLowerCase(),
          "timers.locked_at": new Date(),
        },
      }
    );
  }

  async _onPaymentReported(event) {
    const { tradeId, ipfsHash } = event.args;
    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      {
        $set: {
          status:                       "PAID",
          "evidence.ipfs_receipt_hash": ipfsHash,
          "evidence.receipt_timestamp": new Date(),
          "timers.paid_at":             new Date(),
        },
      }
    );
  }

  async _onEscrowReleased(event) {
    const { tradeId } = event.args;

    // [TR] Status değişiminden önce mevcut durum okunur — haksız challenge tespiti için
    // [EN] Current status read before state change — needed for unjust challenge detection
    const existingTrade = await Trade.findOne({ onchain_escrow_id: Number(tradeId) }).lean();
    const wasDisputed   = existingTrade?.status === "CHALLENGED";

    const trade = await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      { $set: { status: "RESOLVED", "timers.resolved_at": new Date() } },
      { new: true }
    );

    if (!trade) {
      logger.warn(`[Worker] EscrowReleased: Trade #${tradeId} bulunamadı.`);
      return;
    }

    // [TR] RESOLVED: dekont 24 saat içinde silinir (Unutulma Hakkı)
    //      Trade.evidence.receipt_delete_at güncellenir — ayrı Receipt koleksiyonu yok.
    // [EN] RESOLVED: receipt deleted within 24 hours (Right to be Forgotten)
    //      Updates Trade.evidence.receipt_delete_at — no separate Receipt collection.
    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      { $set: { "evidence.receipt_delete_at": new Date(Date.now() + 24 * 3600 * 1000) } }
    );

    // [TR] CHALLENGED → RESOLVED: maker haksız itiraz açtı, failure_score yazılır
    // [EN] CHALLENGED → RESOLVED: maker opened unjust challenge, write failure_score
    if (wasDisputed && trade.maker_address) {
      const scoreType = "unjust_challenge";
      const score     = FAILURE_SCORE_WEIGHTS[scoreType];
      await User.findOneAndUpdate(
        { wallet_address: trade.maker_address },
        {
          $inc:  { "reputation_cache.failure_score": score },
          $push: {
            reputation_history: {
              type: scoreType, score, date: new Date(), tradeId: Number(tradeId),
            },
          },
        }
      );
      logger.info(`[Worker] Failure score updated: ${trade.maker_address} +${score} (${scoreType}) trade #${tradeId}`);
    }
  }

  async _onDisputeOpened(event) {
    const { tradeId } = event.args;
    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      { $set: { status: "CHALLENGED", "timers.challenged_at": new Date() } }
    );
  }

  async _onEscrowCanceled(event) {
    const { tradeId } = event.args;
    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      { $set: { status: "CANCELED", "timers.resolved_at": new Date() } }
    );

    // [TR] CANCELED: dekont 24 saat içinde silinir (Unutulma Hakkı)
    //      Trade.evidence.receipt_delete_at güncellenir — ayrı Receipt koleksiyonu yok.
    // [EN] CANCELED: receipt deleted within 24 hours (Right to be Forgotten)
    //      Updates Trade.evidence.receipt_delete_at — no separate Receipt collection.
    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      { $set: { "evidence.receipt_delete_at": new Date(Date.now() + 24 * 3600 * 1000) } }
    );
  }

  // [TR] Her iki tarafa failure_score yazılır. DLQ retry'da çift yazımı önlemek için
  //      reputation_history'de tradeId+type kombinasyonu kontrol edilir (idempotency).
  // [EN] Writes failure_score to both parties. Idempotency check on reputation_history
  //      (tradeId+type) prevents double-write on DLQ retry.
  async _onEscrowBurned(event) {
    const { tradeId } = event.args;
    const trade = await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      { $set: { status: "BURNED", "timers.resolved_at": new Date() } },
      { new: true }
    );

    if (trade) {
      const scoreType = "burned";
      const score     = FAILURE_SCORE_WEIGHTS[scoreType];
      const addresses = [trade.maker_address, trade.taker_address].filter(Boolean);

      for (const addr of addresses) {
        const existing = await User.findOne({
          wallet_address:     addr,
          reputation_history: { $elemMatch: { type: scoreType, tradeId: Number(tradeId) } },
        }).lean();

        if (existing) {
          logger.debug(`[Worker] Skipping duplicate failure_score for ${addr} trade #${tradeId}`);
          continue;
        }

        await User.findOneAndUpdate(
          { wallet_address: addr },
          {
            $inc:  { "reputation_cache.failure_score": score },
            $push: {
              reputation_history: {
                type: scoreType, score, date: new Date(), tradeId: Number(tradeId),
              },
            },
          }
        );
      }
      logger.info(`[Worker] Burn failure scores: +${score} to ${addresses.length} parties, trade #${tradeId}`);

      // [TR] BURNED: dekont 30 gün sonra silinir (CHALLENGED/BURNED uzun retention)
      //      Trade.evidence.receipt_delete_at güncellenir — ayrı Receipt koleksiyonu yok.
      // [EN] BURNED: receipt deleted after 30 days (longer retention for CHALLENGED/BURNED)
      //      Updates Trade.evidence.receipt_delete_at — no separate Receipt collection.
      await Trade.findOneAndUpdate(
        { onchain_escrow_id: Number(tradeId) },
        { $set: { "evidence.receipt_delete_at": new Date(Date.now() + 30 * 24 * 3600 * 1000) } }
      );
    }
  }

  async _onBleedingDecayed(event) {
    const { tradeId, decayedAmount } = event.args;
    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      {
        $set: { "timers.last_decay_at": new Date() },
        $inc: { "financials.total_decayed": Number(decayedAmount) },
      }
    );
  }

  async _onCancelProposed(event) {
    const { tradeId, proposer } = event.args;
    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      { $set: { "cancel_proposal.proposed_by": proposer.toLowerCase(), "cancel_proposal.proposed_at": new Date() } }
    );
  }

  // [TR] pinger adresi taker_address ile karşılaştırılır: taker ping = autoRelease yolu,
  //      maker ping = challenge yolu. Aynı event ismi (MakerPinged) iki farklı akışı tetikler.
  // [EN] pinger address compared to taker_address: taker ping = autoRelease path,
  //      maker ping = challenge path. Same event name (MakerPinged) drives two distinct flows.
  async _onMakerPinged(event) {
    const { tradeId, pinger } = event.args;

    const trade = await Trade.findOne({ onchain_escrow_id: Number(tradeId) }).lean();
    if (!trade) return;

    const isTakerPing  = pinger.toLowerCase() === trade.taker_address?.toLowerCase();
    const updateFields = isTakerPing
      ? { "timers.pinged_at": new Date(), "pinged_by_taker": true }
      : { "timers.challenge_pinged_at": new Date(), "challenge_pinged_by_maker": true };

    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      { $set: updateFields }
    );
  }

  // [TR] Dot notation kullanılır — failure_score ve reputation_history korunur.
  //      $set: { "reputation_cache": {...} } tüm objeyi değiştirip failure_score'u sıfırlar.
  // [EN] Dot notation used — preserves failure_score and reputation_history.
  //      $set: { "reputation_cache": {...} } would overwrite object and zero out failure_score.
  //
  // ReputationUpdated event 5 parametre taşır: wallet, successful, failed, bannedUntil, effectiveTier.
  // consecutiveBans ve maxAllowedTier bu event'te YOK — o alanlar buradan güncellenmez,
  // aksi hâlde NaN yazılır ve reputationDecay.js sorgusunu bozar.
  async _onReputationUpdated(event) {
    const { wallet, successful, failed, bannedUntil, effectiveTier } = event.args;

    const totalTrades = Number(successful) + Number(failed);
    const successRate = totalTrades > 0
      ? Math.round((Number(successful) / totalTrades) * 100)
      : 100;

    // [TR] Unix timestamp karşılaştırması — bannedUntil 0 ise yasak yok
    // [EN] Unix timestamp comparison — bannedUntil 0 means no ban
    const banTimestamp = Number(bannedUntil);
    const isBanned = banTimestamp > Math.floor(Date.now() / 1000);

    await User.findOneAndUpdate(
      { wallet_address: wallet.toLowerCase() },
      {
        $set: {
          "reputation_cache.success_rate":    successRate,
          "reputation_cache.total_trades":    totalTrades,
          "reputation_cache.failed_disputes": Number(failed),
          //ban state on-chain ile senkronize ediliyor
          "is_banned":    isBanned,
          "banned_until": isBanned ? new Date(banTimestamp * 1000) : null,
          // consecutive_bans ve max_allowed_tier bu event'te yok —
          // yanlış değer yazılmasın. Bu alanlar ayrı on-chain okuma gerektirir.
        },
      },
      { upsert: true }
    );
  }
}

const worker = new EventWorker();
module.exports = worker;
