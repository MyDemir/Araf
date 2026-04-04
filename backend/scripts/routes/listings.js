"use strict";

/**
 * Listings Route — Pazar Yeri CRUD
 *
 * YÜKS-20 Fix: Kararsız Sayfalama Düzeltildi.
 *   ÖNCEKİ: .sort({ exchange_rate: 1 }) — aynı kura sahip ilanlar için
 *   MongoDB sıralama sırasını garanti etmiyordu. Sayfa geçişlerinde
 *   bazı ilanlar iki kez, bazıları hiç görünmüyordu.
 *   ŞİMDİ: .sort({ exchange_rate: 1, _id: 1 }) — _id deterministik sıra sağlar.
 *
 * BACK-02 Fix: RPC Hatasında Tier 0 Mahkumiyeti Düzeltildi.
 *   ÖNCEKİ: _getOnChainEffectiveTier hata verince return 0 (Tier 0 fallback).
 *   Anlık RPC dalgalanmasında Tier 4 kullanıcı Tier 0 muamelesi görüyordu.
 *   ŞİMDİ: Hata durumunda null döner → ilan açma reddedilir + açıklayıcı mesaj.
 *   "Güvenli varsayılan = en kısıtlayıcı değer" mantığı yerine
 *   "Doğrulanamıyorsa işlem yapma" mantığı uygulandı.
 */

const express = require("express");
const Joi     = require("joi");
const router  = express.Router();

const { requireAuth, requireSessionWalletMatch }    = require("../middleware/auth");
const { listingsReadLimiter, listingsWriteLimiter } = require("../middleware/rateLimiter");
const { Listing, Trade }                            = require("../models/Trade");
const logger                                        = require("../utils/logger");
const { getConfig }                                 = require("../services/protocolConfig");

const { ethers } = require("ethers");
const REPUTATION_ABI = [
  "function getReputation(address _wallet) view returns (uint256 successful, uint256 failed, uint256 bannedUntil, uint256 consecutiveBans, uint8 effectiveTier)",
];

// [TR] RPC Provider önbelleği — her istek için yeniden oluşturmayı önler
let _cachedListingsProvider = null;
function _getListingsProvider() {
  if (!_cachedListingsProvider) {
    _cachedListingsProvider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  }
  return _cachedListingsProvider;
}

function _buildListingRef(listingId) {
  return ethers.keccak256(ethers.toUtf8Bytes(`listing:${listingId}`));
}

/**
 * Kullanıcının on-chain efektif tier'ını sorgular.
 *
 * BACK-02 Fix: Hata durumunda null döner (eski: return 0).
 * Çağıran kod null durumunu ele alarak kullanıcıyı bilgilendirmeli.
 *
 * @returns {Promise<number|null>} Tier (0-4) veya null (doğrulanamadı)
 */
async function _getOnChainEffectiveTier(walletAddress) {
  const contractAddress = process.env.ARAF_ESCROW_ADDRESS;

  if (!process.env.BASE_RPC_URL || !contractAddress ||
      contractAddress === "0x0000000000000000000000000000000000000000") {
    // [TR] Development'ta kontrat yoksa tier kontrolü atla
    logger.warn("[Listings] On-chain tier kontrolü atlanıyor (development).");
    return 4;
  }

  try {
    const provider = _getListingsProvider();
    const contract = new ethers.Contract(contractAddress, REPUTATION_ABI, provider);
    const rep = await contract.getReputation(walletAddress);
    return Number(rep.effectiveTier);
  } catch (err) {
    // BACK-02 Fix: Hata durumunda null — "doğrulanamadı" sinyali
    // ÖNCEKİ: return 0 → Tier 4 kullanıcı Tier 0 gibi işleniyordu
    logger.error(`[Listings] On-chain tier sorgusu başarısız: ${err.message}`);
    return null;
  }
}

// ─── GET /api/listings/config ─────────────────────────────────────────────────
// [TR] Frontend bond oranlarını buradan okur (felsefe uyumu — hardcode değil)
router.get("/config", async (req, res, next) => {
  try {
    const config = getConfig();
    return res.json({ bondMap: config.bondMap });
  } catch (err) {
    if (err.code === 'CONFIG_UNAVAILABLE') {
      return res.status(503).json({ error: err.message });
    }
    next(err);
  }
});

// ─── GET /api/listings ────────────────────────────────────────────────────────
router.get("/", listingsReadLimiter, async (req, res, next) => {
  try {
    const schema = Joi.object({
      fiat:   Joi.string().valid("TRY", "USD", "EUR").optional(),
      amount: Joi.number().positive().optional(),
      tier:   Joi.number().valid(0, 1, 2, 3, 4).optional(),
      page:   Joi.number().integer().min(1).default(1),
      limit:  Joi.number().integer().min(1).max(50).default(20),
    });

    const { error, value } = schema.validate(req.query);
    if (error) return res.status(400).json({ error: error.message });

    const filter = { status: "OPEN" };
    if (value.fiat)             filter.fiat_currency = value.fiat;
    if (value.tier !== undefined) filter["tier_rules.required_tier"] = value.tier;
    if (value.amount) {
      filter["limits.min"] = { $lte: value.amount };
      filter["limits.max"] = { $gte: value.amount };
    }

    const skip = (value.page - 1) * value.limit;
    const listings = await Listing.find(filter)
      // YÜKS-20 Fix: _id deterministik sıra — eşit kurda sayfalama tutarlı
      .sort({ exchange_rate: 1, _id: 1 })
      .skip(skip)
      .limit(value.limit)
      .lean();

    const total = await Listing.countDocuments(filter);
    return res.json({ listings, total, page: value.page, limit: value.limit });
  } catch (err) { next(err); }
});

// ─── POST /api/listings ───────────────────────────────────────────────────────
router.post("/", requireAuth, requireSessionWalletMatch, listingsWriteLimiter, async (req, res, next) => {
  try {
    const schema = Joi.object({
      crypto_asset:      Joi.string().valid("USDT", "USDC").required(),
      fiat_currency:     Joi.string().valid("TRY", "USD", "EUR").required(),
      exchange_rate:     Joi.number().positive().required(),
      limits:            Joi.object({
        min: Joi.number().positive().required(),
        max: Joi.number().positive().required(),
      }).required(),
      tier:              Joi.number().valid(0, 1, 2, 3, 4).required(),
      token_address:     Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
      onchain_escrow_id: Joi.number().optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // [TR] min > max kontrolü
    if (value.limits.max <= value.limits.min) {
      return res.status(400).json({ error: "limits.max, limits.min'den büyük olmalı." });
    }

    // [TR] Tier başına nihai tutar kontrolü sadece kontratta authoritative olarak uygulanır.
    // [EN] Tier max-amount enforcement is authoritative on-chain only.

    // BACK-02 Fix: Tier doğrulaması — null = RPC hatası → ret
    const effectiveTier = await _getOnChainEffectiveTier(req.wallet);

    if (effectiveTier === null) {
      // [TR] RPC hatası — kullanıcıyı bilgilendir, Tier 0 muamelesi YAPMA
      return res.status(503).json({
        error: "İtibar veriniz şu an doğrulanamıyor. Lütfen birkaç dakika sonra tekrar deneyin.",
      });
    }

    if (value.tier > effectiveTier) {
      logger.warn(`[Listings] Tier reddedildi: wallet=${req.wallet} istenen=${value.tier} efektif=${effectiveTier}`);
      return res.status(403).json({
        error: `İtibarınız Tier ${value.tier} ilanı için yeterli değil. Efektif tier'ınız: ${effectiveTier}`,
      });
    }

    const config = getConfig();
    const bonds  = config.bondMap[value.tier];

    const listing = new Listing({
      maker_address:     req.wallet,
      crypto_asset:      value.crypto_asset,
      fiat_currency:     value.fiat_currency,
      exchange_rate:     value.exchange_rate,
      limits:            value.limits,
      tier_rules: {
        required_tier:  value.tier,
        maker_bond_pct: bonds.maker,
        taker_bond_pct: bonds.taker,
      },
      // [TR] Chain-first felsefe: ilan önce PENDING oluşturulur.
      //      Event listener EscrowCreated yakaladığında OPEN'a çeker.
      // [EN] Chain-first: listing starts as PENDING and becomes OPEN on EscrowCreated.
      status:            "PENDING",
      token_address:     value.token_address,
      onchain_escrow_id: value.onchain_escrow_id || null,
    });
    listing.listing_ref = _buildListingRef(listing._id.toString()).toLowerCase();
    await listing.save();

    logger.info(`[Listings] Yeni ilan: maker=${req.wallet} tier=${value.tier} asset=${value.crypto_asset}`);
    return res.status(201).json({ listing });
  } catch (err) { next(err); }
});

// ─── DELETE /api/listings/:id ─────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireSessionWalletMatch, async (req, res, next) => {
  try {
    if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
      return res.status(400).json({ error: "Geçersiz ilan ID formatı." });
    }

    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: "İlan bulunamadı." });

    if (listing.maker_address !== req.wallet) {
      logger.warn(`[Listings] Yetkisiz silme: caller=${req.wallet} maker=${listing.maker_address}`);
      return res.status(403).json({ error: "Bu ilan sana ait değil." });
    }

    if (listing.status === "DELETED") {
      return res.status(409).json({ error: "İlan zaten silinmiş." });
    }

    if (listing.onchain_escrow_id) {
      const activeTrade = await Trade.findOne({ onchain_escrow_id: listing.onchain_escrow_id });
      if (activeTrade && activeTrade.status !== "OPEN") {
        logger.warn(`[Listings] Aktif işlem varken silme engellendi: id=${req.params.id}`);
        return res.status(409).json({
          error: "Bu ilana bağlı aktif bir işlem varken ilan silinemez.",
        });
      }
    }

    listing.status = "DELETED";
    await listing.save();

    logger.info(`[Listings] Silindi: id=${req.params.id} maker=${req.wallet}`);
    return res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
