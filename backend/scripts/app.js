"use strict";

require("dotenv").config();
const express       = require("express");
const helmet        = require("helmet");
const cors          = require("cors");
const mongoSanitize = require("express-mongo-sanitize");
const mongoose      = require("mongoose");
const cookieParser  = require("cookie-parser");

// [TR] Yapılandırma ve yardımcı araçlar
// [EN] Configuration and utility helpers
const { connectDB }    = require("./config/db");
const { connectRedis } = require("./config/redis");
const logger           = require("./utils/logger");

// [TR] Ethers.js vb. kütüphane içi gizli çökmeleri sisteme yük bindirmeden dosyaya yazar
// [EN] Catches library-internal hidden crashes without adding load to the system
process.on("uncaughtException", (err) => {
  logger.error("[CRITICAL-EXCEPTION] Beklenmedik Çökme (Sistem Durdu):", { message: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  logger.error("[CRITICAL-REJECTION] Yakalanmamış Promise (Sahipsiz Hata):", { reason });
});

// [TR] On-chain event'lerini MongoDB'ye yansıtan servis
// [EN] Service that mirrors on-chain events to MongoDB
const worker = require("./services/eventListener");

// [TR] Kontrat public constant'larını startup'ta on-chain'den yükler
// [EN] Loads contract public constants from on-chain at startup
const { loadProtocolConfig } = require("./services/protocolConfig");

// [TR] Başarısız event'lerini izleyen ve uyaran Dead Letter Queue monitörü
// [EN] Dead Letter Queue monitor that tracks and alerts on failed events
const { processDLQ } = require("./services/dlqProcessor");

// [TR] 180 günlük temiz sayfa kuralını on-chain'de tetikleyen periyodik görev
// [EN] Periodic job that triggers the 180-day clean slate rule on-chain
const { runReputationDecay } = require("./jobs/reputationDecay");

// [TR] Günlük protokol istatistiklerini MongoDB'ye kaydeden periyodik görev
// [EN] Periodic job that saves daily protocol stats to MongoDB
const { runStatsSnapshot } = require("./jobs/statsSnapshot");

// [TR] Global Express hata yakalayıcı
// [EN] Global Express error handler
const { globalErrorHandler } = require("./middleware/errorHandler");

// [TR] Shutdown sırasında AES master key'i RAM'den sıfırlar
// [EN] Zeroes out AES master key from RAM on shutdown
const { clearMasterKeyCache } = require("./services/encryption");

const app = express();

// [TR] Fly.io / Vercel proxy arkasında gerçek IP için trust proxy
// [EN] Trust proxy for real client IP behind Fly.io / Vercel
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ─Güvenlik Middleware / Security Middleware ─

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "https:"],
    },
  },
  hsts: process.env.NODE_ENV === "production"
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map(o => o.trim())
  .filter(o => o.length > 0);

// [TR] Production'da CORS wildcard ve boş origin engellenir
// [EN] CORS wildcard and empty origins blocked in production
if (process.env.NODE_ENV === "production") {
  if (allowedOrigins.includes("*")) {
    logger.error("[GÜVENLİK] CORS wildcard (*) production'da kullanılamaz! Sunucu durduruluyor.");
    process.exit(1);
  }
  if (allowedOrigins.length === 0) {
    logger.error("[GÜVENLİK] ALLOWED_ORIGINS boş! En az bir origin tanımlayın.");
    process.exit(1);
  }
  for (const origin of allowedOrigins) {
    if (!origin.startsWith("http://") && !origin.startsWith("https://")) {
      logger.error(`[GÜVENLİK] Geçersiz CORS origin: "${origin}" — http:// veya https:// ile başlamalı.`);
      process.exit(1);
    }
  }
  logger.info(`[CORS] İzin verilen origin'ler: ${allowedOrigins.join(", ")}`);
}

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
}));

app.use(express.json({ limit: "50kb" }));

// [TR] JWT, JWT refresh token'ı httpOnly cookie'den okumak için
// [EN] Required to read JWT and refresh token from httpOnly cookie
app.use(cookieParser());

app.use(mongoSanitize({
  replaceWith: "_",
  onSanitize: ({ key }) => logger.warn(`[GÜVENLİK] Mongo injection denemesi engellendi: ${key}`),
}));

//Bootstrap

async function bootstrap() {
  try {
    // [TR] Production'da SIWE_DOMAIN localhost olamaz
    // [EN] SIWE_DOMAIN cannot be localhost in production
    if (process.env.NODE_ENV === "production") {
      const siweDomain = process.env.SIWE_DOMAIN;
      if (!siweDomain || siweDomain === "localhost") {
        logger.error("[GÜVENLİK] SIWE_DOMAIN production'da 'localhost' olamaz! Gerçek domain ayarlayın.");
        process.exit(1);
      }
    }

    await connectDB();
    await connectRedis();
    logger.info("MongoDB ve Redis bağlantıları başarıyla sağlandı.");

    await loadProtocolConfig();

    await worker.start();
    logger.info("Event Listener (Zincir Dinleyici) aktif: Base L2 ağı izleniyor.");

    // [TR] DLQ monitörü — her 60 saniyede başarısız event'leri kontrol eder
    // [EN] DLQ monitor — checks failed events every 60 seconds
    const dlqInterval = setInterval(processDLQ, 60_000);

    // [TR] İlk çalıştırma 30 sn geciktirilir — cold start'ta DB'ye eş zamanlı yük binmesini önler
    // [EN] First run delayed by 30s — prevents simultaneous DB load on cold start
    const reputationDecayDelay = setTimeout(() => {
      runReputationDecay();
      logger.info("Periyodik İtibar İyileştirme görevi zamanlandı (her 24 saatte bir).");
    }, 30_000);
    const reputationDecayInterval = setInterval(runReputationDecay, 24 * 60 * 60 * 1000);

    const statsSnapshotDelay = setTimeout(() => {
      runStatsSnapshot();
      logger.info("Periyodik İstatistik Kaydetme görevi zamanlandı (her 24 saatte bir).");
    }, 60_000);
    const statsSnapshotInterval = setInterval(runStatsSnapshot, 24 * 60 * 60 * 1000);

    // [TR] Rotalar DB ve Redis hazır olduktan sonra yüklenir
    // [EN] Routes loaded after DB and Redis are ready
    
    // [TR] Frontend Senkronize Log Rotası (Yük bindirmeyen yapı)
    const logRoutes      = require("./routes/logs");
    
    const authRoutes     = require("./routes/auth");
    const listingRoutes  = require("./routes/listings");
    const tradeRoutes    = require("./routes/trades");
    const piiRoutes      = require("./routes/pii");
    const feedbackRoutes = require("./routes/feedback");
    const statsRoutes    = require("./routes/stats");
    const receiptRoutes  = require("./routes/receipts");

    // [TR] Log rotası en üstte tanımlanır
    app.use("/api/logs",     logRoutes);
    
    app.use("/api/auth",     authRoutes);
    app.use("/api/listings", listingRoutes);
    app.use("/api/trades",   tradeRoutes);
    app.use("/api/pii",      piiRoutes);
    app.use("/api/feedback", feedbackRoutes);
    app.use("/api/stats",    statsRoutes);
    app.use("/api/receipts", receiptRoutes);

    app.get("/health", (req, res) => res.json({
      status:    "ok",
      worker:    "active",
      timestamp: new Date().toISOString(),
    }));

    app.use((req, res) => res.status(404).json({ error: "İstenen endpoint bulunamadı" }));

    app.use(globalErrorHandler);

    const PORT   = process.env.PORT || 4000;
    const server = app.listen(PORT, () => {
      logger.info(`===========================================================`);
      logger.info(`🚀 Araf Protocol Backend Dinleniyor: Port ${PORT}`);
      logger.info(`🌍 Ortam: ${process.env.NODE_ENV || 'development'}`);
      logger.warn(`🛡️  Güvenlik: Zero Private Key Modu Aktif.`);
      logger.info(`===========================================================`);
    });

    // [TR] Graceful shutdown — clearMasterKeyCache ile plaintext key bellekten sıfırlanır.
    const shutdown = async (signal) => {
      logger.info(`${signal} alındı. Graceful shutdown başlıyor...`);
      clearMasterKeyCache();
      clearInterval(dlqInterval);
      clearTimeout(reputationDecayDelay);
      clearInterval(reputationDecayInterval);
      clearTimeout(statsSnapshotDelay);
      clearInterval(statsSnapshotInterval);
      server.close(async () => {
        await worker.stop();
        await mongoose.connection.close();
        logger.info("Tüm bağlantılar kapatıldı. Çıkış yapılıyor.");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));

  } catch (err) {
    logger.error("Uygulama başlatılırken kritik hata oluştu:", err);
    process.exit(1);
  }
}

bootstrap();

module.exports = app;
