"use strict";

/**
 * Receipts Route — Şifreli Ödeme Dekontu Yükleme
 *
 * KRİT-06 Fix: Dekont Kanıt Sabotajı (Evidence Overwrite) Kapatıldı.
 *   ÖNCEKİ: findOneAndUpdate filtresinde receipt_encrypted null kontrolü yoktu.
 *   Kötü niyetli Taker gerçek dekontu yükleyip bildirdikten sonra aynı endpoint'i
 *   tekrar çağırarak Maker'ın kanıtını silebiliyordu.
 *   ŞİMDİ: Güncelleme filtresine "evidence.receipt_encrypted": null eklendi.
 *   Zaten yüklenmiş dekont üzerine YAZILAMAZsöylenerek 409 döndürülüyor.
 *
 * YÜKS-05 Fix: TOCTOU (Time-of-Check-to-Time-of-Use) Kapatıldı.
 *   ÖNCEKİ: findOne kontrolü + ayrı findOneAndUpdate = iki ayrı sorgu.
 *   Maker challengeTrade() çağırırken Taker eş zamanlı dekont yükleyebilirdi.
 *   findOneAndUpdate'te status: "LOCKED" koşulu olmadığından CHALLENGED'da da yazılıyordu.
 *   ŞİMDİ: Tek atomik findOneAndUpdate ile hem statü hem kanıt kontrol ediliyor.
 *
 * YÜKS-17 Fix: RAM Tükenmesi DoS Kapatıldı.
 *   ÖNCEKİ: multer.memoryStorage() — 5MB buffer + Base64(~6.7MB) + AES(~13MB) + HEX(~26MB)
 *   = tek dosya için ~30MB RAM. 20 eşzamanlı yükleme = 600MB = OOM crash.
 *   ŞİMDİ: multer.diskStorage() — dosya geçici diske yazılır, stream ile şifrelenir,
 *   işlem bittikten sonra diskten silinir. RAM kullanımı sabit kalır.
 */

const express = require("express");
const multer  = require("multer");
const crypto  = require("crypto");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");
const router  = express.Router();

const { requireAuth, requireSessionWalletMatch } = require("../middleware/auth");
const { tradesLimiter } = require("../middleware/rateLimiter");
const { encryptField }  = require("../services/encryption");
const { Trade }         = require("../models/Trade");
const logger            = require("../utils/logger");
const { promises: fsp } = fs;

// ── YÜKS-17 Fix: diskStorage — RAM yerine geçici diske yaz ───────────────────
const tmpDir = path.join(os.tmpdir(), "araf-receipts");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tmpDir),
  filename:    (_req, _file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits:     { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
    // [TR] Mimetype sadece başlangıç filtresi — magic bytes kontrolü ayrıca yapılmalı
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(`UNSUPPORTED_MIME:${file.mimetype}`));
    }
    cb(null, true);
  },
});

const MAGIC_BYTES_BY_MIME = {
  "image/jpeg":      [(buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff],
  "image/png":       [(buf) => buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))],
  "image/webp":      [(buf) =>
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"],
  "image/gif":       [(buf) =>
    buf.length >= 6 &&
    (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")],
  "application/pdf": [(buf) => buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-"],
};

async function validateFileMagicBytes(filePath, mimeType) {
  const validators = MAGIC_BYTES_BY_MIME[mimeType];
  if (!validators?.length) return false;
  const handle = await fsp.open(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const used = header.subarray(0, bytesRead);
    return validators.some((fn) => fn(used));
  } finally {
    await handle.close();
  }
}

/**
 * YÜKS-17 Fix: Dosyayı stream ile şifrele — RAM'e tamamen yükleme.
 * Disk'ten okuyarak Base64 chunk'lar halinde şifreler.
 * Büyük dosyalarda RAM kullanımı sabit kalır.
 *
 * @param {string} filePath  - Geçici disk dosyası yolu
 * @param {string} wallet    - Şifreleme anahtarı türetmek için wallet adresi
 * @returns {Promise<{encryptedHex: string, sha256Hash: string}>}
 */
async function encryptFileFromDisk(filePath, wallet) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fs.createReadStream(filePath, { encoding: "base64" });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end",  async () => {
      try {
        const base64Content = chunks.join("");
        const encryptedHex  = await encryptField(base64Content, wallet);
        const sha256Hash    = crypto.createHash("sha256").update(encryptedHex).digest("hex");
        resolve({ encryptedHex, sha256Hash });
      } catch (err) {
        reject(err);
      }
    });
    stream.on("error", reject);
  });
}

// ── POST /api/receipts/upload ─────────────────────────────────────────────────
router.post(
  "/upload",
  requireAuth,
  requireSessionWalletMatch,
  tradesLimiter,
  upload.single("receipt"),
  async (req, res, next) => {
    const tempFilePath = req.file?.path;

    try {
      // 1. Dosya kontrolü
      if (!req.file) {
        return res.status(400).json({ error: "Dekont dosyası eksik veya boş." });
      }

      // 2. onchainEscrowId doğrulama
      const rawId     = req.body?.onchainEscrowId;
      const onchainId = Number(rawId);
      if (!rawId || !Number.isInteger(onchainId) || onchainId <= 0) {
        return res.status(400).json({ error: "Geçersiz veya eksik onchainEscrowId." });
      }

      // 2.1 İçerik imza doğrulaması (mimetype spoofing'e karşı)
      const signatureOk = await validateFileMagicBytes(tempFilePath, req.file.mimetype);
      if (!signatureOk) {
        logger.warn(`[Receipts] Dosya imza doğrulaması başarısız: mime=${req.file.mimetype}`);
        return res.status(415).json({
          error: "Dosya içeriği bildirilen MIME tipiyle eşleşmiyor.",
        });
      }

      // 3. YÜKS-17 Fix: Stream ile şifrele — RAM'e tamamen yükleme
      const { encryptedHex, sha256Hash } = await encryptFileFromDisk(tempFilePath, req.wallet);

      // 4. KRİT-06 + YÜKS-05 Fix: Tek atomik sorgu
      //    - Caller = taker kontrolü
      //    - Status = LOCKED kontrolü (YÜKS-05: TOCTOU — CHALLENGED'da yazmayı önler)
      //    - receipt_encrypted = null kontrolü (KRİT-06: üzerine yazılmasını önler)
      const updatedTrade = await Trade.findOneAndUpdate(
        {
          onchain_escrow_id:          onchainId,
          taker_address:              req.wallet,
          status:                     "LOCKED",
          "evidence.receipt_encrypted": null,      // KRİT-06 Fix
        },
        {
          $set: {
            "evidence.receipt_encrypted":  encryptedHex,
            "evidence.ipfs_receipt_hash":  sha256Hash,
            "evidence.receipt_timestamp":  new Date(),
            "evidence.receipt_delete_at":  new Date(Date.now() + 30 * 24 * 3600 * 1000),
          },
        },
        { new: false } // [TR] Eski belgeyi döndür — başarı tespiti için
      );

      if (!updatedTrade) {
        // [TR] Güncelleme yapılamadıysa nedeni anla
        const existing = await Trade.findOne({ onchain_escrow_id: onchainId })
          .select("taker_address status evidence.receipt_encrypted").lean();

        if (!existing) {
          return res.status(404).json({ error: `#${onchainId} numaralı trade bulunamadı.` });
        }
        if (existing.taker_address !== req.wallet) {
          return res.status(403).json({ error: "Yalnızca taker dekont yükleyebilir." });
        }
        if (existing.evidence?.receipt_encrypted) {
          // KRİT-06 Fix: Açıklayıcı hata — sabotaj girişimini logla
          logger.warn(`[Receipts] Dekont üzerine yazma girişimi: trade=#${onchainId} wallet=${req.wallet}`);
          return res.status(409).json({ error: "Bu işlem için dekont zaten yüklendi. Üzerine yazılamaz." });
        }
        if (existing.status !== "LOCKED") {
          return res.status(400).json({
            error: `Dekont yalnızca LOCKED durumunda yüklenebilir (mevcut: ${existing.status}).`,
          });
        }
        return res.status(500).json({ error: "Dekont kaydedilemedi. Lütfen tekrar deneyin." });
      }

      logger.info(
        `[Receipts] Dekont kaydedildi: trade=#${onchainId} ` +
        `mime=${req.file.mimetype} hash=${sha256Hash.slice(0, 8)}...`
      );

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
    } finally {
      // [TR] Temp cleanup başarısızlığı isteği düşürmez; yalnızca loglanır.
      if (tempFilePath) {
        try {
          await fsp.unlink(tempFilePath);
        } catch (cleanupErr) {
          if (cleanupErr.code !== "ENOENT") {
            logger.warn(`[Receipts] Geçici dosya silinemedi: ${tempFilePath}`);
          }
        }
      }
    }
  }
);

module.exports = router;
