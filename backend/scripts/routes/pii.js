"use strict";

/**
 * PII Route — IBAN Fetch (En Yüksek Güvenlik Seviyeli Endpoint)
 *
 * [TR] İki adımlı erişim akışı:
 *   1. POST /request-token/:tradeId
 *      JWT auth doğrulanır, caller taker mı kontrol edilir,
 *      kısa ömürlü PII token döner.
 *   2. GET /:tradeId
 *      PII token ile şifresi çözülmüş IBAN döner (loglanmaz, önbelleklenmez).
 *
 * Ek endpoint'ler:
 *   GET /my              — Kullanıcının kendi PII verisi (profil ayarlar sekmesi)
 *   GET /taker-name/:id  — Maker için taker'ın banka sahibi adı (triangulation koruması)
 *
 * [EN] Two-step access flow:
 *   1. POST /request-token/:tradeId — validates JWT, confirms caller is taker, issues PII token.
 *   2. GET /:tradeId — returns decrypted IBAN with PII token (not logged, not cached).
 *
 * Additional endpoints:
 *   GET /my              — User's own PII data (profile settings tab)
 *   GET /taker-name/:id  — Taker's bank owner name for maker (triangulation fraud prevention)
 */

const express = require("express");
const router  = express.Router();

const { requireAuth, requirePIIToken } = require("../middleware/auth");
const { piiLimiter }                   = require("../middleware/rateLimiter");
const { Trade }                        = require("../models/Trade");
const User                             = require("../models/User");
const { decryptPII }                   = require("../services/encryption");
const { issuePIIToken }                = require("../services/siwe");
const logger                           = require("../utils/logger");

// ─── GET /api/pii/my ─────────────────────────────────────────────────────────

// [TR] Kullanıcının kendi PII verisi — profil ayarlar sekmesinde formu doldurur.
//      Wallet'a özgü DEK ile şifresi çözülür.
// [EN] User's own PII data — pre-fills the profile settings form.
//      Decrypted with wallet-specific DEK.
router.get("/my", requireAuth, piiLimiter, async (req, res, next) => {
  try {
    const user = await User.findOne({ wallet_address: req.wallet })
      .select("pii_data")
      .lean();

    if (!user || !user.pii_data) {
      return res.json({ pii: null });
    }

    const decrypted = await decryptPII(user.pii_data, req.wallet);
    logger.info(`[PII] /my accessed: wallet=${req.wallet}`);
    return res.json({ pii: decrypted });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/pii/taker-name/:onchainId ──────────────────────────────────────

// [TR] Maker'a taker'ın banka hesabı sahibi adını gösterir.
//      Amaç: Triangulation dolandırıcılık koruması — maker, gelen paranın
//      doğru isimden geldiğini teyit edebilsin.
//      Sadece trade'in maker'ı çağırabilir.
// [EN] Shows taker's bank account owner name to the maker.
//      Purpose: Triangulation fraud prevention — maker verifies incoming
//      payment came from the correct name.
//      Only the trade's maker can call this.
router.get("/taker-name/:onchainId", requireAuth, piiLimiter, async (req, res, next) => {
  try {
    const onchainId = Number(req.params.onchainId);
    if (!Number.isInteger(onchainId) || onchainId <= 0) {
      return res.status(400).json({ error: "Geçersiz on-chain ID formatı." });
    }

    const trade = await Trade.findOne({ onchain_escrow_id: onchainId })
      .select("maker_address taker_address status")
      .lean();

    if (!trade) {
      return res.status(404).json({ error: "Trade bulunamadı." });
    }

    // [TR] Sadece maker görebilir — taker kendi adını istemez
    // [EN] Only maker can view — taker does not need their own name
    if (trade.maker_address !== req.wallet) {
      logger.warn(`[PII] Yetkisiz taker-name erişimi: caller=${req.wallet} maker=${trade.maker_address}`);
      return res.status(403).json({ error: "Yalnızca satıcı (maker) alıcının ismini görebilir." });
    }

    // [TR] Trade LOCKED veya üstü durumda olmalı (taker mevcut)
    // [EN] Trade must be LOCKED or above (taker exists)
    const allowedStates = ["LOCKED", "PAID", "CHALLENGED"];
    if (!allowedStates.includes(trade.status)) {
      return res.status(400).json({ error: `Taker bilgisi ${trade.status} durumunda alınamaz.` });
    }

    if (!trade.taker_address) {
      return res.json({ bankOwner: null });
    }

    const takerUser = await User.findOne({ wallet_address: trade.taker_address })
      .select("pii_data")
      .lean();

    if (!takerUser?.pii_data?.bankOwner_enc) {
      return res.json({ bankOwner: null });
    }

    const decrypted = await decryptPII(takerUser.pii_data, trade.taker_address);

    logger.info(`[PII] taker-name accessed: maker=${req.wallet} taker=${trade.taker_address} onchain=${onchainId}`);
    return res.json({ bankOwner: decrypted.bankOwner });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/pii/request-token/:tradeId ────────────────────────────────────

// [TR] Adım 1: IBAN verisine erişmek için kısa ömürlü (15 dk), trade bazlı PII token talep eder.
// [EN] Step 1: Requests short-lived (15 min), trade-scoped PII token for IBAN access.
router.post(
  "/request-token/:tradeId",
  requireAuth,
  piiLimiter,
  async (req, res, next) => {
    try {
      const { tradeId }    = req.params;
      const callerWallet   = req.wallet;

      if (!/^[a-fA-F0-9]{24}$/.test(tradeId)) {
        return res.status(400).json({ error: "Geçersiz tradeId formatı." });
      }

      const trade = await Trade.findById(tradeId).lean();
      if (!trade) {
        return res.status(404).json({ error: "Trade bulunamadı." });
      }

      // [TR] Yalnızca taker IBAN talep edebilir — maker kendi IBAN'ını başka endpoint'ten alır
      // [EN] Only taker can request IBAN — maker gets own IBAN via /my endpoint
      if (trade.taker_address !== callerWallet) {
        logger.warn(`[PII] Yetkisiz token talebi: caller=${callerWallet} taker=${trade.taker_address} trade=${tradeId}`);
        return res.status(403).json({ error: "Yalnızca taker PII token talep edebilir." });
      }

      const allowedStates = ["LOCKED", "PAID", "CHALLENGED"];
      if (!allowedStates.includes(trade.status)) {
        return res.status(400).json({ error: `PII token ${trade.status} durumunda alınamaz.` });
      }

      const piiToken = issuePIIToken(callerWallet, tradeId);

      logger.info(`[PII] Token issued: wallet=${callerWallet} trade=${tradeId}`);
      return res.json({ piiToken });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/pii/:tradeId ────────────────────────────────────────────────────

// [TR] Adım 2: Kısa ömürlü PII token ile satıcının şifresi çözülmüş banka bilgilerini döner.
//      Yanıt loglanmaz, önbelleklenmez.
// [EN] Step 2: Returns decrypted seller bank details with short-lived PII token.
//      Response is not logged or cached.
router.get(
  "/:tradeId",
  requirePIIToken,
  piiLimiter,
  async (req, res, next) => {
    try {
      const { tradeId }  = req.params;
      const callerWallet = req.wallet;

      const trade = await Trade.findById(tradeId)
        .select("maker_address status taker_address")
        .lean();

      if (!trade) {
        return res.status(404).json({ error: "Trade bulunamadı." });
      }

      if (trade.taker_address !== callerWallet) {
        return res.status(403).json({ error: "Yetkisiz erişim." });
      }

      const makerUser = await User.findOne({ wallet_address: trade.maker_address })
        .select("pii_data")
        .lean();

      if (!makerUser || !makerUser.pii_data) {
        return res.status(404).json({ error: "Satıcı ödeme bilgilerini henüz girmemiş." });
      }

      const decrypted = await decryptPII(makerUser.pii_data, trade.maker_address);

      logger.info(`[PII] Accessed: taker=${callerWallet} maker=${trade.maker_address} trade=${tradeId}`);

      return res.json({
        bankOwner: decrypted.bankOwner,
        iban:      decrypted.iban,
        telegram:  decrypted.telegram,
        notice:    "Bu bilgiler şifreli kanaldan iletildi. Blockchain'e veya loglara kaydedilmez.",
      });
    } catch (err) {
      if (err.message?.includes("Unsupported state") || err.message?.includes("Invalid auth tag")) {
        logger.error(`[PII] Şifre çözme hatası: trade=${req.params.tradeId}: ${err.message}`);
        return res.status(500).json({ error: "Şifre çözme başarısız. Destek ekibiyle iletişime geçin." });
      }
      next(err);
    }
  }
);

module.exports = router;
