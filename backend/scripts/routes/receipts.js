"use strict";

/**
 * Receipts Route — Şifreli Ödeme Dekontu Yükleme
 *
 * [TR] Mimari (ARCHITECTURE_TR.md Bölüm 9.6–9.7):
 *      Dekont ASLA public IPFS'e veya zincire yüklenmez.
 *      Akış:
 *        1. Taker dosyayı multipart/form-data olarak gönderir (field: "receipt").
 *           onchainEscrowId text field'ı ile hangi trade'e ait olduğu belirtilir.
 *        2. Dosya belleğe alınır (diske yazılmaz — multer memoryStorage).
 *        3. Dosya base64'e çevrilir, mevcut encryptField() ile AES-256-GCM şifrelenir.
 *           Anahtar türetimi: taker wallet adresi → HKDF DEK (wallet'a özgü).
 *        4. SHA-256(encrypted_data) hesaplanır → kontrata gidecek hash.
 *        5. Şifreli veri Trade.evidence.receipt_encrypted'a yazılır.
 *        6. Hash frontend'e döner; frontend reportPayment() ile bunu on-chain'e yazar.
 *      TTL (Unutulma Hakkı / GDPR-KVKK):
 *        - eventListener, RESOLVED/CANCELED → +24 saat, CHALLENGED/BURNED → +30 gün
 *          olarak Trade.evidence.receipt_delete_at alanını günceller.
 *        - receipt_delete_at dolunca receipt_encrypted alanı null'a çekilir.
 *
 * [EN] Architecture (ARCHITECTURE_EN.md Section 9.6–9.7):
 *      Receipt is NEVER uploaded to public IPFS or the blockchain.
 *      Flow:
 *        1. Taker sends file as multipart/form-data (field: "receipt").
 *           onchainEscrowId text field identifies which trade it belongs to.
 *        2. File is kept in memory (never written to disk — multer memoryStorage).
 *        3. File is base64-encoded, then AES-256-GCM encrypted via existing encryptField().
 *           Key derivation: taker wallet address → HKDF DEK (wallet-scoped).
 *        4. SHA-256(encrypted_data) computed → hash that goes to the contract.
 *        5. Encrypted data written to Trade.evidence.receipt_encrypted.
 *        6. Hash returned to frontend; frontend writes it on-chain via reportPayment().
 *      TTL (Right to be Forgotten / GDPR-KVKK):
 *        - eventListener sets Trade.evidence.receipt_delete_at:
 *          RESOLVED/CANCELED → +24h, CHALLENGED/BURNED → +30d.
 *        - receipt_encrypted nulled when receipt_delete_at passes.
 */

const express = require("express");
const multer  = require("multer");
const crypto  = require("crypto");
const router  = express.Router();

const { requireAuth }   = require("../middleware/auth");
const { tradesLimiter } = require("../middleware/rateLimiter");
// [TR] Mevcut encryption.js — encryptField base64 string şifreler, wallet DEK kullanır.
//      Ayrı encryptBuffer yazmaya gerek yok: buffer → base64 → encryptField yeterli.
// [EN] Existing encryption.js — encryptField encrypts base64 strings using wallet DEK.
//      No need for a separate encryptBuffer: buffer → base64 → encryptField suffices.
const { encryptField }  = require("../services/encryption");
const { Trade }         = require("../models/Trade");
const logger            = require("../utils/logger");

// ── Multer ───────────────────────────────────────────────────────────────────

// [TR] Dosya yalnızca bellekte — diske asla yazılmaz
// [EN] File in memory only — never written to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(`UNSUPPORTED_MIME:${file.mimetype}`));
    }
    cb(null, true);
  },
});

// ── POST /api/receipts/upload ─────────────────────────────────────────────────

/**
 * [TR] Beklenen form alanları:
 *   receipt         (file) — dekont dosyası (JPEG/PNG/WebP/GIF/PDF, maks 5MB)
 *   onchainEscrowId (text) — aktif trade'in on-chain escrow ID'si
 *
 * [EN] Expected form fields:
 *   receipt         (file) — receipt file (JPEG/PNG/WebP/GIF/PDF, max 5MB)
 *   onchainEscrowId (text) — active trade's on-chain escrow ID
 *
 * Response: { hash: "<sha256_hex>" }
 */
router.post(
  "/upload",
  requireAuth,
  tradesLimiter,
  upload.single("receipt"),
  async (req, res, next) => {
    try {
      // ── 1. Dosya kontrolü ─────────────────────────────────────────────────
      if (!req.file?.buffer || req.file.size === 0) {
        return res.status(400).json({ error: "Dekont dosyası eksik veya boş." });
      }

      // ── 2. onchainEscrowId doğrulama ──────────────────────────────────────
      const rawId     = req.body?.onchainEscrowId;
      const onchainId = Number(rawId);
      if (!rawId || !Number.isInteger(onchainId) || onchainId <= 0) {
        return res.status(400).json({ error: "Geçersiz veya eksik onchainEscrowId." });
      }

      // ── 3. Trade doğrulama ────────────────────────────────────────────────
      // [TR] Caller taker mı? Trade LOCKED durumunda mı?
      // [EN] Is caller the taker? Is trade in LOCKED status?
      const trade = await Trade.findOne({ onchain_escrow_id: onchainId })
        .select("taker_address status")
        .lean();

      if (!trade) {
        return res.status(404).json({ error: `#${onchainId} numaralı trade bulunamadı.` });
      }
      if (trade.taker_address !== req.wallet) {
        logger.warn(
          `[Receipts] Yetkisiz yükleme: caller=${req.wallet} taker=${trade.taker_address} trade=#${onchainId}`
        );
        return res.status(403).json({ error: "Yalnızca taker dekont yükleyebilir." });
      }
      if (trade.status !== "LOCKED") {
        return res.status(400).json({
          error: `Dekont yalnızca LOCKED durumunda yüklenebilir (mevcut: ${trade.status}).`,
        });
      }

      // ── 4. Şifreleme ──────────────────────────────────────────────────────
      // [TR] buffer → base64 → encryptField() → AES-256-GCM hex
      //      Context = taker wallet adresi → wallet'a özgü HKDF DEK
      // [EN] buffer → base64 → encryptField() → AES-256-GCM hex
      //      Context = taker wallet address → wallet-scoped HKDF DEK
      const fileBuffer   = req.file.buffer;
      const encryptedHex = await encryptField(fileBuffer.toString("base64"), req.wallet);

      // ── 5. SHA-256 hash ───────────────────────────────────────────────────
      // [TR] SHA-256(encrypted_data) → on-chain'e yazılacak değer.
      //      "ipfsReceiptHash" tarihsel isim — IPFS yok, şifreli verinin parmak izi.
      // [EN] SHA-256(encrypted_data) → value to be written on-chain.
      //      "ipfsReceiptHash" is a historical name — no IPFS, just encrypted data fingerprint.
      const sha256Hash = crypto
        .createHash("sha256")
        .update(encryptedHex)
        .digest("hex");

      // ── 6. Trade.evidence'a yaz ───────────────────────────────────────────
      // [TR] Ayrı Receipt koleksiyonu yok — Trade belgesi zaten burada.
      //      receipt_delete_at: eventListener trade bitince gerçek değeri set eder.
      //      Varsayılan +30 gün = worst-case TTL güvencesi.
      // [EN] No separate Receipt collection — Trade document already exists here.
      //      receipt_delete_at: eventListener sets real value when trade concludes.
      //      Default +30 days = worst-case TTL guarantee.
      await Trade.findOneAndUpdate(
        { onchain_escrow_id: onchainId },
        {
          $set: {
            "evidence.receipt_encrypted":  encryptedHex,
            "evidence.ipfs_receipt_hash":  sha256Hash,
            "evidence.receipt_timestamp":  new Date(),
            "evidence.receipt_delete_at":  new Date(Date.now() + 30 * 24 * 3600 * 1000),
          },
        }
      );

      logger.info(
        `[Receipts] Dekont kaydedildi: trade=#${onchainId} taker=${req.wallet} ` +
        `size=${fileBuffer.length}B mime=${req.file.mimetype} hash=${sha256Hash.slice(0, 8)}...`
      );

      // [TR] Frontend'e sadece hash döner — şifreli baytlar asla istemciye gitmez
      // [EN] Only hash returned to frontend — encrypted bytes never leave the server
      return res.status(201).json({ hash: sha256Hash });

    } catch (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Dosya boyutu 5 MB sınırını aşıyor." });
      }
      if (err.message?.startsWith("UNSUPPORTED_MIME:")) {
        const mime = err.message.split(":")[1];
        return res.status(415).json({
          error: `Desteklenmeyen dosya tipi: ${mime}. İzin verilenler: JPEG, PNG, WebP, GIF, PDF`,
        });
      }
      next(err);
    }
  }
);

module.exports = router;
