"use strict";
/* ## eventListener.js hardening and integrity cleanup

This PR updates `backend/scripts/services/eventListener.js` to preserve the existing event-processing safety fixes while making `EscrowCreated` linkage failures stricter and more explicit.

### Existing protections that remain

This file already contained multiple important hardening changes, and they remain in place:

- challenged → resolved reputation flow penalizes the unjust challenger instead of the maker
- listing matching no longer falls back to hardcoded financial defaults
- checkpoint advancement remains tied to successful processing instead of blindly moving forward on failure
- reconnect still cleans up old provider listeners / sockets before rebuilding
- release / burn flows still use MongoDB transactions for atomic updates
- bleeding decay idempotency still uses canonical event identity (`txHash:logIndex`)
- `reputation_history` remains capped instead of growing forever
- IPFS hash input still goes through CID validation before persistence
- `MakerPinged` still waits for DB state instead of guessing missing taker state
- large financial amounts continue to be mirrored as strings to avoid precision loss

### Previous behavior

`EscrowCreated` already preferred authoritative `listingRef` matching, but if the event arrived with a zero or missing `listingRef`, the worker treated it more like a delayed / recoverable linkage problem:

- log a warning
- send the event to DLQ
- stop processing

That was safer than heuristics, but it still framed the condition as an operational lag problem rather than a protocol/API integrity failure.

### New behavior

Zero `listingRef` is now treated as a critical invalid creation path.

New behavior in `_onEscrowCreated()`:

- detect missing or zero `listingRef`
- log the condition as `CRITICAL`
- explicitly mark it as invalid contract / API usage
- send it to DLQ with a critical linkage error message
- do not treat it as recoverable heuristic matching failure

### Effect

This makes the worker align with the stricter linkage doctrine:

- no heuristic backfill
- no silent recovery
- no pretending that on-chain creation is valid when canonical off-chain linkage was never established

In other words, this change upgrades zero-ref handling from:

> “missing data, retry later”

to:

> “invalid canonical creation path, investigate immediately”

### Scope

Only `backend/scripts/services/eventListener.js` was targeted here.*/
const { ethers } = require("ethers");
const mongoose = require("mongoose");
const { getRedisClient } = require("../config/redis");
const { Trade, Listing } = require("../models/Trade");
const User = require("../models/User");
const logger = require("../utils/logger");

const CHECKPOINT_KEY = "worker:last_block";
const LAST_SAFE_BLOCK_KEY = "worker:last_safe_block";
const DLQ_KEY = "worker:dlq";
const RETRY_DELAY_MS = 5_000;
const MAX_RETRIES = 3;
const BLOCK_BATCH_SIZE = 1_000;
const CHECKPOINT_INTERVAL_BLOCKS = 50;

// reputation_history sınırsız büyümesin diye üst sınır tutulur.
const MAX_REPUTATION_HISTORY = 100;

const FAILURE_SCORE_WEIGHTS = {
  burned: 50,
  unjust_challenge: 20,
  passive_maker: 20,
  failed_dispute: 20,
};

// Kabul edilen IPFS/CID biçimleri.
// Geçersiz hash durumunda trade state güncellenebilir ama hash saklanmaz.
const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58}|[a-f0-9]{64})$/;

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
  "event EscrowCreated(uint256 indexed tradeId, address indexed maker, address token, uint256 amount, uint8 tier, bytes32 listingRef)",
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

const EVENT_ARG_KEYS = {
  WalletRegistered: ["wallet", "timestamp"],
  EscrowCreated: ["tradeId", "maker", "token", "amount", "tier", "listingRef"],
  EscrowLocked: ["tradeId", "taker", "takerBond"],
  PaymentReported: ["tradeId", "ipfsHash", "timestamp"],
  EscrowReleased: ["tradeId", "maker", "taker", "takerFee", "makerFee"],
  DisputeOpened: ["tradeId", "challenger", "timestamp"],
  CancelProposed: ["tradeId", "proposer"],
  EscrowCanceled: ["tradeId", "makerRefund", "takerRefund"],
  MakerPinged: ["tradeId", "pinger", "timestamp"],
  ReputationUpdated: ["wallet", "successful", "failed", "bannedUntil", "effectiveTier"],
  BleedingDecayed: ["tradeId", "decayedAmount", "timestamp"],
  EscrowBurned: ["tradeId", "burnedAmount"],
};

class EventWorker {
  constructor() {
    this.provider = null;
    this.contract = null;
    this.isRunning = false;
    this._lastCheckpointBlock = 0;
    this._state = "booting";
    this._reconnectPromise = null;
    this._listenersAttached = false;
    this._retrySuccessCount = 0;
    this._retryFailureCount = 0;
    this._blockAcks = new Map();
    this._lastSeenBlock = 0;
    this._lastSafeCheckpointBlock = 0;
    this._replayInProgress = false;

    // [TR] Live path artık contract.on(...) yerine block-range polling kullanır.
    // [EN] Live path now uses block-range polling instead of contract.on(...).
    this._livePollInProgress = false;
    this._lastLivePolledBlock = 0;
  }

  async start() {
    logger.info("[Worker] Event listener başlatılıyor...");
    this.isRunning = true;
    await this._connect();
    await this._replayMissedEvents();

    // [TR] Replay tamamlandıktan sonra live polling başlangıç referansı güncel block olur.
    // [EN] After replay finishes, current block becomes the live polling baseline.
    if (this.provider) {
      this._lastLivePolledBlock = await this.provider.getBlockNumber();
    }

    this._attachLiveListeners();
    logger.info("[Worker] Event listener aktif.");
  }

  async stop() {
    this.isRunning = false;
    if (this.provider) {
      this.provider.removeAllListeners();
    }
    this._listenersAttached = false;
    this._livePollInProgress = false;
    this._setState("stopped", "worker stop çağrıldı");
    logger.info("[Worker] Event listener durduruldu.");
  }

  _setState(nextState, reason) {
    if (this._state === nextState) return;
    logger.info(`[Worker][StateMachine] ${this._state} -> ${nextState}${reason ? ` | ${reason}` : ""}`);
    this._state = nextState;
  }

  async _connect() {
    const isProduction = process.env.NODE_ENV === "production";
    const rpcUrl = process.env.BASE_RPC_URL || (!isProduction ? "https://mainnet.base.org" : null);
    const contractAddress = process.env.ARAF_ESCROW_ADDRESS;

    if (!contractAddress || contractAddress === "0x0000000000000000000000000000000000000000") {
      if (isProduction) {
        logger.error("[Worker] KRİTİK: ARAF_ESCROW_ADDRESS tanımlı değil. Durduruluyor.");
        process.exit(1);
      }
      logger.warn("[Worker] Kontrat adresi yok — Worker kuru çalışma modunda (development).");
      return;
    }

    if (!rpcUrl) {
      throw new Error("[Worker] KRİTİK: BASE_RPC_URL production'da zorunludur.");
    }

    const wsRpcUrl = process.env.BASE_WS_RPC_URL;

    if (wsRpcUrl && wsRpcUrl.startsWith("wss://")) {
      try {
        this.provider = new ethers.WebSocketProvider(wsRpcUrl);
        logger.info("[Worker] WebSocket RPC bağlandı.");
      } catch (wsErr) {
        logger.warn(`[Worker] WebSocket başarısız, HTTP fallback: ${wsErr.message}`);
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
      }
    } else {
      this.provider = new ethers.JsonRpcProvider(rpcUrl);
      if (isProduction) {
        logger.warn("[Worker] HTTP RPC kullanılıyor. Gerçek zamanlı event için BASE_WS_RPC_URL önerilir.");
      }
    }

    this.contract = new ethers.Contract(contractAddress, ARAF_ABI, this.provider);
    logger.info(`[Worker] Kontrat izleniyor: ${contractAddress}`);
    this._setState("connected", "provider + kontrat hazır");
  }

  async _replayMissedEvents() {
    if (!this.contract) return;

    const redis = getRedisClient();
    const savedBlock = await redis.get(LAST_SAFE_BLOCK_KEY) ?? await redis.get(CHECKPOINT_KEY);
    const toBlock = await this.provider.getBlockNumber();
    const fromBlock = this._resolveReplayStartBlock(savedBlock, toBlock);

    if (fromBlock > toBlock) {
      logger.info("[Worker] Kaçırılan event yok. Checkpoint güncel.");
      return;
    }

    this._setState("replaying", `replay aralığı: ${fromBlock}-${toBlock}`);
    logger.info(`[Worker] ${fromBlock} - ${toBlock} blok aralığı tekrar işleniyor...`);

    for (let from = fromBlock; from <= toBlock; from += BLOCK_BATCH_SIZE) {
      const to = Math.min(from + BLOCK_BATCH_SIZE - 1, toBlock);

      const allEvents = [];
      for (const eventName of EVENT_NAMES) {
        try {
          const filtered = await this.contract.queryFilter(eventName, from, to);
          if (Array.isArray(filtered)) allEvents.push(...filtered);
        } catch (err) {
          logger.warn(`[Worker] Replay: ${eventName} sorgusu başarısız (${from}-${to}): ${err.message}`);
        }
      }

      allEvents.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

      let batchSuccess = true;
      for (const event of allEvents) {
        try {
          await this._processEvent(event);
        } catch (err) {
          logger.error(`[Worker] Replay event işleme hatası: ${event.eventName} - ${err.message}`);
          await this._addToDLQ(event, err.message);
          batchSuccess = false;
        }
      }

      // Replay sırasında safe checkpoint yalnız tamamen başarılı batch sonunda ilerler.
      if (batchSuccess) {
        await this._updateSafeCheckpointIfHigher(to);
      } else {
        logger.warn(`[Worker] Batch ${from}-${to} kısmen başarısız — checkpoint ilerletilmedi.`);
      }

      logger.debug(`[Worker] Replay: ${from}-${to} (${allEvents.length} event)`);
    }

    logger.info("[Worker] Replay tamamlandı.");
  }

  _attachLiveListeners() {
    if (!this.contract || this._listenersAttached) return;

    // [TR] Canlı dinleme artık contract.on(...) ile tek tek event abonesi açmaz.
    //      Bunun yerine yeni block sinyalini tetik olarak kullanır ve son işlenen
    //      bloktan güncel bloğa kadar olan aralığı queryFilter(...) ile tarar.
    //
    // [EN] Live mode no longer opens per-event contract.on(...) subscriptions.
    //      Instead, each new block is treated as a trigger and the worker scans
    //      the full block range from the last processed block to the current block
    //      via queryFilter(...).
    //
    // Bu yaklaşım:
    // - replay ve live path'i aynı veri toplama mantığına yaklaştırır
    // - missed event riskini azaltır
    // - provider subscriber/filter-id kaynaklı kırılganlığı düşürür
    this.provider.on("block", async (blockNumber) => {
      if (this._livePollInProgress) {
        logger.debug(`[Worker] Live poll zaten çalışıyor — block=${blockNumber} için yeni tetik atlandı.`);
        return;
      }

      this._livePollInProgress = true;

      try {
        await this._updateSeenBlockIfHigher(blockNumber);

        const fromBlock = this._lastLivePolledBlock + 1;
        const toBlock = blockNumber;

        if (fromBlock <= toBlock) {
          await this._pollLiveRange(fromBlock, toBlock);

          // [TR] Range başarıyla sorgulanıp işlendiği anda live cursor ilerletilir.
          //      Kısmi event hataları _markBlockUnsafe ile checkpoint'i durdurur;
          //      ama aynı range'i her block'ta tekrar sorgulamak duplicate baskısı yaratır.
          this._lastLivePolledBlock = toBlock;
        }

        logger.debug(
          `[Worker][Metrics] queue_depth=${this._blockAcks.size} last_seen_block=${this._lastSeenBlock} last_safe_block=${this._lastSafeCheckpointBlock}`
        );

        const finalizedUpTo = blockNumber - 1;
        await this._advanceSafeCheckpointFromAcks(finalizedUpTo);

        if (!this._replayInProgress && (blockNumber - this._lastSafeCheckpointBlock >= CHECKPOINT_INTERVAL_BLOCKS)) {
          this._replayInProgress = true;
          try {
            await this._replayMissedEvents();
          } finally {
            this._replayInProgress = false;
          }
        }
      } catch (err) {
        logger.error(`[Worker] Live block-range poll hatası: ${err.message}`);
      } finally {
        this._livePollInProgress = false;
      }
    });

    this.provider.on("error", async (err) => {
      logger.error(`[Worker] Provider hatası: ${err.message}. Yeniden bağlanılıyor...`);
      await this._reconnect();
    });

    this._listenersAttached = true;
    this._setState("live", "canlı block-range listener bağlandı");
  }

  // [TR] Belirli block aralığındaki event'leri canlı modda toplar ve işler.
  //      Replay ile aynı queryFilter mantığını kullanır, ancak canlı akış için
  //      block ack/state bookkeeping de yapar.
  //
  // [EN] Collects and processes events for a given block range in live mode.
  //      Uses the same queryFilter model as replay, but additionally updates
  //      block ack/state bookkeeping required by safe checkpoint advancement.
  async _pollLiveRange(fromBlock, toBlock) {
    if (!this.contract || fromBlock > toBlock) return;

    for (let from = fromBlock; from <= toBlock; from += BLOCK_BATCH_SIZE) {
      const to = Math.min(from + BLOCK_BATCH_SIZE - 1, toBlock);

      try {
        const allEvents = [];
        for (const eventName of EVENT_NAMES) {
          const filtered = await this.contract.queryFilter(eventName, from, to);
          if (Array.isArray(filtered)) allEvents.push(...filtered);
        }

        allEvents.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

        // [TR] Boş bloklar checkpoint akışını kilitlemesin diye aralıktaki her blok için
        //      ack state önceden oluşturulur. Eğer bir blokta event yoksa seen=0/acked=0
        //      olarak güvenli şekilde ilerlenebilir.
        this._seedAckStateForRange(from, to);

        for (const event of allEvents) {
          const eventId = this._getEventId(event);
          this._trackLiveEventSeen(event);

          const success = await this._processEventWithRetry(event);
          if (success) {
            this._trackLiveEventAck(event);
            logger.debug(`[Worker][Metrics] retry_success_rate=${this._getRetrySuccessRate()}% event_id=${eventId}`);
          } else {
            this._markBlockUnsafe(event.blockNumber);
          }
        }

        logger.debug(`[Worker] Live poll: ${from}-${to} (${allEvents.length} event)`);
      } catch (err) {
        // [TR] Range sorgusu veya toplama katmanı patlarsa bu aralık checkpoint açısından
        //      güvenli kabul edilmez. Aynı range daha sonra replay/live akışında yeniden ele alınır.
        this._seedAckStateForRange(from, to);
        this._markRangeUnsafe(from, to);
        throw err;
      }
    }
  }

  // [TR] Bir bloğun ack bookkeeping state'ini garanti eder.
  // [EN] Ensures a block has an ack bookkeeping state.
  _ensureBlockAckState(blockNumber) {
    const existing = this._blockAcks.get(blockNumber);
    if (existing) return existing;

    const state = { seen: new Set(), acked: new Set(), unsafe: false };
    this._blockAcks.set(blockNumber, state);
    return state;
  }

  // [TR] Boş blokların safe checkpoint ilerlemesini durdurmaması için aralıktaki
  //      tüm bloklara başlangıç ack state'i eklenir.
  // [EN] Seeds ack state for every block in a range so empty blocks do not block
  //      safe checkpoint advancement.
  _seedAckStateForRange(fromBlock, toBlock) {
    for (let block = fromBlock; block <= toBlock; block += 1) {
      this._ensureBlockAckState(block);
    }
  }

  // [TR] Belirli block aralığını unsafe olarak işaretler.
  // [EN] Marks a block range as unsafe.
  _markRangeUnsafe(fromBlock, toBlock) {
    for (let block = fromBlock; block <= toBlock; block += 1) {
      this._markBlockUnsafe(block);
    }
  }

  async _updateSafeCheckpointIfHigher(blockNumber) {
    const redis = getRedisClient();
    const current = parseInt(await redis.get(LAST_SAFE_BLOCK_KEY) || await redis.get(CHECKPOINT_KEY) || "0");
    if (blockNumber > current) {
      await redis.set(LAST_SAFE_BLOCK_KEY, blockNumber.toString());
      await redis.set(CHECKPOINT_KEY, blockNumber.toString());
      this._lastSafeCheckpointBlock = blockNumber;
    }
  }

  async _updateSeenBlockIfHigher(blockNumber) {
    if (blockNumber > this._lastSeenBlock) this._lastSeenBlock = blockNumber;
  }

  _resolveReplayStartBlock(savedBlock, currentBlock) {
    if (savedBlock !== null && savedBlock !== undefined) {
      const checkpoint = Number(savedBlock);
      if (!Number.isInteger(checkpoint) || checkpoint < 0) {
        throw new Error(`[Worker] Geçersiz checkpoint değeri: ${savedBlock}`);
      }
      if (checkpoint > currentBlock) {
        throw new Error(`[Worker] Checkpoint current block'u aşıyor: checkpoint=${checkpoint} current=${currentBlock}`);
      }
      return checkpoint + 1;
    }

    const configuredStartRaw = process.env.ARAF_DEPLOYMENT_BLOCK ?? process.env.WORKER_START_BLOCK;

    if (configuredStartRaw === undefined || configuredStartRaw === null || configuredStartRaw === "") {
      if (process.env.NODE_ENV === "production") {
        throw new Error("[Worker] Production için checkpoint veya ARAF_DEPLOYMENT_BLOCK/WORKER_START_BLOCK zorunludur.");
      }
      logger.warn("[Worker] Checkpoint bulunamadı ve başlangıç bloğu tanımlı değil. Varsayılan başlangıç: 0.");
      return 0;
    }

    const configuredStart = Number(configuredStartRaw);
    if (!Number.isInteger(configuredStart) || configuredStart < 0) {
      throw new Error(`[Worker] Geçersiz başlangıç bloğu: ${configuredStartRaw}.`);
    }
    if (configuredStart > currentBlock) {
      throw new Error(`[Worker] Başlangıç bloğu current block'tan büyük olamaz: start=${configuredStart} current=${currentBlock}`);
    }

    logger.info(`[Worker] Checkpoint bulunamadı. Başlangıç bloğu env'den alındı: ${configuredStart}`);
    return configuredStart;
  }

  _getEventId(event) {
    const txHash = event?.transactionHash || "unknown_tx";
    const logIndex = Number.isInteger(event?.logIndex) ? event.logIndex : -1;
    return `${txHash}:${logIndex}`;
  }

  _trackLiveEventSeen(event) {
    if (!event || !Number.isInteger(event.blockNumber)) return;
    const eventId = this._getEventId(event);
    const state = this._ensureBlockAckState(event.blockNumber);
    state.seen.add(eventId);
    this._blockAcks.set(event.blockNumber, state);
  }

  _trackLiveEventAck(event) {
    if (!event || !Number.isInteger(event.blockNumber)) return;
    const eventId = this._getEventId(event);
    const state = this._ensureBlockAckState(event.blockNumber);
    state.acked.add(eventId);
    this._blockAcks.set(event.blockNumber, state);
  }

  _markBlockUnsafe(blockNumber) {
    if (!Number.isInteger(blockNumber)) return;
    const state = this._ensureBlockAckState(blockNumber);
    state.unsafe = true;
    this._blockAcks.set(blockNumber, state);
  }

  async _advanceSafeCheckpointFromAcks(finalizedUpTo) {
    if (!Number.isInteger(finalizedUpTo) || finalizedUpTo <= this._lastSafeCheckpointBlock) return;

    let nextSafe = this._lastSafeCheckpointBlock;
    for (let block = this._lastSafeCheckpointBlock + 1; block <= finalizedUpTo; block += 1) {
      const state = this._blockAcks.get(block);
      if (!state) break;
      if (state.unsafe || state.acked.size < state.seen.size) break;
      nextSafe = block;
    }

    if (nextSafe > this._lastSafeCheckpointBlock) {
      await this._updateSafeCheckpointIfHigher(nextSafe);
      for (const block of [...this._blockAcks.keys()]) {
        if (block <= nextSafe) this._blockAcks.delete(block);
      }
    }
  }

  _getRetrySuccessRate() {
    const total = this._retrySuccessCount + this._retryFailureCount;
    if (total === 0) return 100;
    return Math.round((this._retrySuccessCount / total) * 100);
  }

  async _reconnect() {
    if (this._reconnectPromise) {
      logger.warn("[Worker] Reconnect zaten devam ediyor, mevcut işlem bekleniyor.");
      return this._reconnectPromise;
    }

    this._reconnectPromise = (async () => {
      this._setState("reconnecting", "provider error sonrası yeniden bağlanma");

      // Reconnect öncesi eski provider mutlaka temizlenir.
      // Bu, zombi WebSocket birikmesini engeller.
      if (this.provider) {
        try {
          this.provider.removeAllListeners();
          if (this.provider.destroy) {
            await this.provider.destroy();
          }
        } catch (err) {
          logger.warn(`[Worker] Provider temizleme hatası: ${err.message}`);
        }
        this.provider = null;
        this.contract = null;
        this._listenersAttached = false;
        this._livePollInProgress = false;
      }

      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      await this._connect();
      await this._replayMissedEvents();

      if (this.provider) {
        this._lastLivePolledBlock = await this.provider.getBlockNumber();
      }

      if (this.contract) {
        this._attachLiveListeners();
      }
    })();

    try {
      await this._reconnectPromise;
    } finally {
      this._reconnectPromise = null;
    }
  }

  async _processEventWithRetry(event, attempt = 1) {
    try {
      await this._processEvent(event);
      this._retrySuccessCount += 1;
      return true;
    } catch (err) {
      logger.error(`[Worker] ${event.eventName} başarısız (deneme ${attempt}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        return this._processEventWithRetry(event, attempt + 1);
      }
      this._retryFailureCount += 1;
      await this._addToDLQ(event, err.message);
      return false;
    }
  }

  async _processEventWithRetryNoDLQ(event, attempt = 1) {
    try {
      await this._processEvent(event);
      this._retrySuccessCount += 1;
      return { success: true };
    } catch (err) {
      logger.error(`[Worker] Re-drive ${event.eventName} başarısız (deneme ${attempt}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        return this._processEventWithRetryNoDLQ(event, attempt + 1);
      }
      this._retryFailureCount += 1;
      return { success: false, error: err.message };
    }
  }

  async _addToDLQ(event, errorMsg) {
    const redis = getRedisClient();
    const nowIso = new Date().toISOString();
    const entry = JSON.stringify({
      eventName: event.eventName,
      txHash: event.transactionHash,
      logIndex: event.logIndex ?? null,
      idempotencyKey: this._getEventId(event),
      blockNumber: event.blockNumber,
      args: Array.isArray(event.args)
        ? event.args.map((a) => a?.toString?.() ?? String(a))
        : Object.values(event.args || {}).map((a) => a?.toString?.() ?? String(a)),
      attempt: 0,
      next_retry_at: nowIso,
      first_seen_at: nowIso,
      last_error: errorMsg,
    });

    await redis.rPush(DLQ_KEY, entry);
    logger.error(
      `[Worker] Event DLQ'ya eklendi: ${event.eventName} key=${this._getEventId(event)} tx=${event.transactionHash}`
    );
  }

  async reDriveEvent(entry) {
    const event = {
      eventName: entry.eventName,
      transactionHash: entry.txHash,
      logIndex: entry.logIndex ?? -1,
      blockNumber: entry.blockNumber,
      args: entry.args || [],
    };

    const result = await this._processEventWithRetryNoDLQ(event);
    if (!result.success) {
      this._markBlockUnsafe(event.blockNumber);
    }
    return result;
  }

  async _processEvent(event) {
    const handlers = {
      WalletRegistered: this._onWalletRegistered.bind(this),
      EscrowCreated: this._onEscrowCreated.bind(this),
      EscrowLocked: this._onEscrowLocked.bind(this),
      PaymentReported: this._onPaymentReported.bind(this),
      EscrowReleased: this._onEscrowReleased.bind(this),
      DisputeOpened: this._onDisputeOpened.bind(this),
      CancelProposed: this._onCancelProposed.bind(this),
      EscrowCanceled: this._onEscrowCanceled.bind(this),
      MakerPinged: this._onMakerPinged.bind(this),
      ReputationUpdated: this._onReputationUpdated.bind(this),
      BleedingDecayed: this._onBleedingDecayed.bind(this),
      EscrowBurned: this._onEscrowBurned.bind(this),
    };

    const handler = handlers[event.eventName];
    if (handler) {
      await handler(event);
      logger.debug(`[Worker] İşlendi: ${event.eventName} tx=${event.transactionHash}`);
    }
  }

  async _onWalletRegistered(event) {
    const { wallet } = event.args;
    await User.findOneAndUpdate(
      { wallet_address: wallet.toLowerCase() },
      { $setOnInsert: { wallet_address: wallet.toLowerCase() } },
      { upsert: true }
    );
  }

  async _onEscrowCreated(event) {
    const { tradeId, maker, amount, tier } = event.args;
    const tradeIdNum = Number(tradeId);

    const onchainToken = event.args.token?.toLowerCase();
    const listingRef = event.args.listingRef?.toLowerCase?.() || null;
    const isZeroRef = !listingRef || /^0x0{64}$/.test(listingRef);

    // Zero listingRef artık recoverable lag gibi yorumlanmıyor.
    // Bu durum, kontrat veya frontend çağrı disiplininde kritik linkage ihlali kabul edilir.
    if (isZeroRef) {
      logger.error(
        `[Worker] CRITICAL: EscrowCreated event'i zero listingRef ile geldi! ` +
        `trade=#${tradeIdNum} tx=${event.transactionHash} — ` +
        `Bu kontrat seviyesinde engellenmiş olmalı. Manuel inceleme gerekiyor.`
      );
      await this._addToDLQ(event, "CRITICAL: zero listingRef — kontrat fix öncesi oluştu");
      return;
    }

    const listing = await Listing.findOne({ listing_ref: listingRef }).lean();
    if (!listing) {
      logger.warn(`[Worker] EscrowCreated: listing_ref bulunamadı trade=#${tradeIdNum} ref=${listingRef}`);
      await this._addToDLQ(event, `listing_ref bulunamadı: ${listingRef}`);
      return;
    }

    const makerMatches = listing.maker_address === maker.toLowerCase();
    const tierMatches = Number(listing.tier_rules?.required_tier) === Number(tier);
    const tokenMatches = (listing.token_address || "").toLowerCase() === (onchainToken || "");

    if (!makerMatches || !tierMatches || !tokenMatches) {
      logger.warn(`[Worker] EscrowCreated authoritative ref mismatch trade=#${tradeIdNum} ref=${listingRef}`);
      await this._addToDLQ(event, "listing_ref bulundu fakat on-chain maker/tier/token doğrulaması başarısız.");
      return;
    }

    if (listing.onchain_escrow_id !== null && listing.onchain_escrow_id !== tradeIdNum) {
      await this._addToDLQ(event, `listing_ref başka escrow'a bağlı: ${listing.onchain_escrow_id}`);
      return;
    }

    if (listing.onchain_escrow_id === null) {
      const linkResult = await Listing.updateOne(
        { _id: listing._id, listing_ref: listingRef, onchain_escrow_id: null },
        { $set: { onchain_escrow_id: tradeIdNum, status: "OPEN" } }
      );

      if (!linkResult.modifiedCount) {
        logger.warn(
          `[Worker] EscrowCreated: authoritative listing link race trade=#${tradeIdNum} listing=${listing._id}`
        );
        await this._addToDLQ(event, "Authoritative listing link race — onchain_escrow_id atomik bağlanamadı.");
        return;
      }
    }

    // Büyük sayılar Mongo mirror'da string olarak saklanır.
    // Sayısal alanlar yalnız analitik / approx görüntüleme içindir.
    const financials = {
      crypto_amount: amount.toString(),
      crypto_amount_num: Number(amount),
      exchange_rate: listing.exchange_rate,
      crypto_asset: listing.crypto_asset,
      fiat_currency: listing.fiat_currency,
      total_decayed: "0",
      total_decayed_num: 0,
      decay_tx_hashes: [],
      decayed_amounts: [],
    };

    await Trade.findOneAndUpdate(
      { onchain_escrow_id: tradeIdNum },
      {
        $setOnInsert: {
          onchain_escrow_id: tradeIdNum,
          listing_id: listing._id,
          maker_address: maker.toLowerCase(),
          status: "OPEN",
          tier: Number(tier),
          financials,
        },
      },
      { upsert: true }
    );
  }

  async _onEscrowLocked(event) {
    const { tradeId, taker } = event.args;
    const tradeIdNum = Number(tradeId);
    const takerAddress = taker.toLowerCase();

    // LOCKED anında maker/taker şifreli alanları trade içine snapshot alınır.
    // Böylece kullanıcı profilini sonra değiştirirse geçmiş trade referansı kaymaz.
    const trade = await Trade.findOne({ onchain_escrow_id: tradeIdNum })
      .select("maker_address")
      .lean();

    let makerBankOwnerEnc = null;
    let makerIbanEnc = null;
    let takerBankOwnerEnc = null;

    if (trade?.maker_address) {
      const [makerUser, takerUser] = await Promise.all([
        User.findOne({ wallet_address: trade.maker_address })
          .select("pii_data.bankOwner_enc pii_data.iban_enc")
          .lean(),
        User.findOne({ wallet_address: takerAddress })
          .select("pii_data.bankOwner_enc")
          .lean(),
      ]);

      makerBankOwnerEnc = makerUser?.pii_data?.bankOwner_enc || null;
      makerIbanEnc = makerUser?.pii_data?.iban_enc || null;
      takerBankOwnerEnc = takerUser?.pii_data?.bankOwner_enc || null;
    }

    await Trade.findOneAndUpdate(
      { onchain_escrow_id: tradeIdNum },
      {
        $set: {
          status: "LOCKED",
          taker_address: takerAddress,
          "timers.locked_at": new Date(),
          "pii_snapshot.maker_bankOwner_enc": makerBankOwnerEnc,
          "pii_snapshot.maker_iban_enc": makerIbanEnc,
          "pii_snapshot.taker_bankOwner_enc": takerBankOwnerEnc,
          "pii_snapshot.captured_at": new Date(),
          "pii_snapshot.snapshot_delete_at": new Date(Date.now() + 30 * 24 * 3600 * 1000),
        },
      }
    );
  }

  async _onPaymentReported(event) {
    const { tradeId, ipfsHash } = event.args;

    const safeHash = CID_PATTERN.test(ipfsHash) ? ipfsHash : null;
    if (!safeHash) {
      logger.warn(`[Worker] Geçersiz IPFS hash formatı: trade=#${tradeId} hash=${ipfsHash?.slice(0, 20)}...`);
    }

    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      {
        $set: {
          status: "PAID",
          "evidence.ipfs_receipt_hash": safeHash,
          "evidence.receipt_timestamp": new Date(),
          "timers.paid_at": new Date(),
        },
      }
    );
  }

  async _onEscrowReleased(event) {
    const { tradeId } = event.args;
    const tradeIdNum = Number(tradeId);

    const existingTrade = await Trade.findOne({ onchain_escrow_id: tradeIdNum }).lean();
    const wasDisputed = existingTrade?.status === "CHALLENGED";

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const trade = await Trade.findOneAndUpdate(
        { onchain_escrow_id: tradeIdNum },
        { $set: { status: "RESOLVED", "timers.resolved_at": new Date() } },
        { new: true, session }
      );

      if (!trade) {
        await session.abortTransaction();
        logger.warn(`[Worker] EscrowReleased: Trade #${tradeId} bulunamadı.`);
        return;
      }

      await Trade.findOneAndUpdate(
        { onchain_escrow_id: tradeIdNum },
        { $set: { "evidence.receipt_delete_at": new Date(Date.now() + 24 * 3600 * 1000) } },
        { session }
      );

      // CHALLENGED -> RESOLVED akışı, maker'ın release yaptığı ve itirazın haksız kaldığı durumdur.
      // Bu durumda ceza maker'a değil taker'a yazılır.
      if (wasDisputed && trade.taker_address) {
        const scoreType = "unjust_challenge";
        const score = FAILURE_SCORE_WEIGHTS[scoreType];

        await User.findOneAndUpdate(
          { wallet_address: trade.taker_address },
          {
            $inc: { "reputation_cache.failure_score": score },
            $push: {
              reputation_history: {
                $each: [{ type: scoreType, score, date: new Date(), tradeId: tradeIdNum }],
                $slice: -MAX_REPUTATION_HISTORY,
              },
            },
          },
          { session }
        );

        logger.info(`[Worker] Haksız itiraz cezası: taker=${trade.taker_address} +${score}`);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
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
      {
        $set: {
          status: "CANCELED",
          "timers.resolved_at": new Date(),
          "evidence.receipt_delete_at": new Date(Date.now() + 24 * 3600 * 1000),
        },
      }
    );
  }

  async _onEscrowBurned(event) {
    const { tradeId } = event.args;
    const tradeIdNum = Number(tradeId);

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const trade = await Trade.findOneAndUpdate(
        { onchain_escrow_id: tradeIdNum },
        {
          $set: {
            status: "BURNED",
            "timers.resolved_at": new Date(),
            "evidence.receipt_delete_at": new Date(Date.now() + 30 * 24 * 3600 * 1000),
          },
        },
        { new: true, session }
      );

      if (trade) {
        const scoreType = "burned";
        const score = FAILURE_SCORE_WEIGHTS[scoreType];
        const addresses = [trade.maker_address, trade.taker_address].filter(Boolean);

        for (const addr of addresses) {
          const existing = await User.findOne(
            {
              wallet_address: addr,
              reputation_history: { $elemMatch: { type: scoreType, tradeId: tradeIdNum } },
            },
            null,
            { session }
          ).lean();

          if (existing) {
            logger.debug(`[Worker] Duplicate failure_score atlandı: ${addr} trade #${tradeId}`);
            continue;
          }

          await User.findOneAndUpdate(
            { wallet_address: addr },
            {
              $inc: { "reputation_cache.failure_score": score },
              $push: {
                reputation_history: {
                  $each: [{ type: scoreType, score, date: new Date(), tradeId: tradeIdNum }],
                  $slice: -MAX_REPUTATION_HISTORY,
                },
              },
            },
            { session }
          );
        }

        logger.info(`[Worker] Burn cezası: +${score} to ${addresses.length} taraf, trade #${tradeId}`);
      }

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async _onBleedingDecayed(event) {
    const { tradeId, decayedAmount } = event.args;
    const tradeIdNum = Number(tradeId);
    const eventId = this._getEventId(event);
    const decayedAmountStr = decayedAmount.toString();
    const decayedAmountNum = Number(decayedAmount);

    // Idempotency anahtarı txHash:logIndex kullanır.
    // Aynı decay event'i tekrar işlense bile aynı eventId ikinci kez yazılmaz.
    const updateResult = await Trade.updateOne(
      {
        onchain_escrow_id: tradeIdNum,
        "financials.decay_tx_hashes": { $ne: eventId },
      },
      [
        {
          $set: {
            "timers.last_decay_at": new Date(),
            "financials.total_decayed": {
              $toString: {
                $add: [
                  { $toDecimal: { $ifNull: ["$financials.total_decayed", "0"] } },
                  { $toDecimal: decayedAmountStr },
                ],
              },
            },
            "financials.total_decayed_num": {
              $add: [{ $ifNull: ["$financials.total_decayed_num", 0] }, decayedAmountNum],
            },
            "financials.decay_tx_hashes": {
              $concatArrays: [{ $ifNull: ["$financials.decay_tx_hashes", []] }, [eventId]],
            },
            "financials.decayed_amounts": {
              $concatArrays: [{ $ifNull: ["$financials.decayed_amounts", []] }, [decayedAmountStr]],
            },
          },
        },
      ]
    );

    if (updateResult.matchedCount === 0) return;
    if (updateResult.modifiedCount === 0) {
      logger.debug(`[Worker] BleedingDecayed tekrar işleme atlandı: key=${eventId}`);
    }
  }

  async _onCancelProposed(event) {
    const { tradeId, proposer } = event.args;
    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      {
        $set: {
          "cancel_proposal.proposed_by": proposer.toLowerCase(),
          "cancel_proposal.proposed_at": new Date(),
        },
      }
    );
  }

  async _onMakerPinged(event) {
    const { tradeId, pinger } = event.args;

    const trade = await Trade.findOne({ onchain_escrow_id: Number(tradeId) }).lean();
    if (!trade) return;

    // taker_address henüz yoksa kontrattan tekrar tahmin üretmek yerine event sırasını bekleriz.
    if (!trade.taker_address) {
      logger.warn(`[Worker] MakerPinged: Trade #${tradeId} taker_address henüz null — DLQ'ya alınıyor.`);
      await this._addToDLQ(event, "taker_address henüz DB'de yok — EscrowLocked gecikmiş olabilir.");
      return;
    }

    const isTakerPing = pinger.toLowerCase() === trade.taker_address.toLowerCase();
    const updateFields = isTakerPing
      ? { "timers.pinged_at": new Date(), "pinged_by_taker": true }
      : { "timers.challenge_pinged_at": new Date(), "challenge_pinged_by_maker": true };

    await Trade.findOneAndUpdate(
      { onchain_escrow_id: Number(tradeId) },
      { $set: updateFields }
    );
  }

  async _onReputationUpdated(event) {
    const { wallet, successful, failed, bannedUntil } = event.args;

    const totalTrades = Number(successful) + Number(failed);
    const successRate = totalTrades > 0
      ? Math.round((Number(successful) / totalTrades) * 100)
      : 100;

    const banTimestamp = Number(bannedUntil);
    const isBanned = banTimestamp > Math.floor(Date.now() / 1000);

    await User.findOneAndUpdate(
      { wallet_address: wallet.toLowerCase() },
      {
        $set: {
          "reputation_cache.success_rate": successRate,
          "reputation_cache.total_trades": totalTrades,
          "reputation_cache.failed_disputes": Number(failed),
          "is_banned": isBanned,
          "banned_until": isBanned ? new Date(banTimestamp * 1000) : null,
        },
      },
      { upsert: true }
    );
  }
}

const worker = new EventWorker();

worker.buildSyntheticEventFromDLQEntry = function buildSyntheticEventFromDLQEntry(entry) {
  const mappedArgs = { ...(entry.namedArgs || {}) };

  if (!Object.keys(mappedArgs).length && Array.isArray(entry.args)) {
    const keys = EVENT_ARG_KEYS[entry.eventName] || [];
    keys.forEach((key, i) => {
      if (entry.args[i] !== undefined) mappedArgs[key] = entry.args[i];
    });
  }

  return {
    eventName: entry.eventName,
    transactionHash: entry.txHash,
    blockNumber: entry.blockNumber,
    args: mappedArgs,
  };
};

worker.reprocessDLQEntry = async function reprocessDLQEntry(entry) {
  if (!entry?.eventName) return false;

  try {
    const syntheticEvent = worker.buildSyntheticEventFromDLQEntry(entry);
    await worker._processEvent(syntheticEvent);
    return true;
  } catch (err) {
    logger.error(`[Worker] DLQ re-drive başarısız: ${entry.eventName} tx=${entry.txHash} err=${err.message}`);
    return false;
  }
};

module.exports = worker;
