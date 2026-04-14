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
const { connectRedis, getRedisClient } = require("./config/redis");
const logger           = require("./utils/logger");

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
const { runPendingListingCleanup } = require("./jobs/cleanupPendingListings");
const { getReadiness, getLiveness } = require("./services/health");
const {
  runReceiptCleanup,
  runPIISnapshotCleanup,
} = require("./jobs/cleanupSensitiveData");

// [TR] Global Express hata yakalayıcı
// [EN] Global Express error handler
const { globalErrorHandler } = require("./middleware/errorHandler");

// [TR] Shutdown sırasında AES master key'i RAM'den sıfırlar
// [EN] Zeroes out AES master key from RAM on shutdown
const { clearMasterKeyCache } = require("./services/encryption");

const app = express();
let server = null;
let isShuttingDown = false;
const FATAL_EXIT_TIMEOUT_MS = 8_000;

// [TR] Proxy arkasında gerçek client IP'yi her ortamda doğru almak için koşulsuz trust proxy.
// [EN] Unconditional trust proxy so real client IP is preserved behind reverse proxies.
app.set("trust proxy", 1);

// ─Güvenlik Middleware / Security Middleware ─
app.use(helmet({
  frameguard: false, // [EKLE] Farcaster iframe engelini (X-Frame-Options) kaldırır
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "https:"],
      frameAncestors: ["'self'", "https://*.warpcast.com", "https://warpcast.com"], // [EKLE] İzinli iframe kaynakları
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
  let dlqInterval = null;
  let reputationDecayDelay = null;
  let reputationDecayInterval = null;
  let statsSnapshotDelay = null;
  let statsSnapshotInterval = null;
  let pendingCleanupDelay = null;
  let pendingCleanupInterval = null;

  const clearRuntimeSchedulers = () => {
    if (dlqInterval) clearInterval(dlqInterval);
    if (reputationDecayDelay) clearTimeout(reputationDecayDelay);
    if (reputationDecayInterval) clearInterval(reputationDecayInterval);
    if (statsSnapshotDelay) clearTimeout(statsSnapshotDelay);
    if (statsSnapshotInterval) clearInterval(statsSnapshotInterval);
    if (pendingCleanupDelay) clearTimeout(pendingCleanupDelay);
    if (pendingCleanupInterval) clearInterval(pendingCleanupInterval);
  };

  const shutdown = async ({ signal = "UNKNOWN", exitCode = 0, reason = null }) => {
    if (isShuttingDown) {
      logger.warn(`[ORCHESTRATOR] Shutdown zaten devam ediyor (${signal}). İkinci tetikleme yok sayıldı.`);
      return;
    }
    isShuttingDown = true;

    const isFatal = exitCode !== 0;
    if (isFatal) {
      logger.error(`[ORCHESTRATOR] FATAL shutdown başlatıldı (${signal}). Exit code=${exitCode}; restart bekleniyor.`);
      if (reason) {
        logger.error("[ORCHESTRATOR] FATAL nedeni:", reason);
      }
    } else {
      logger.info(`[ORCHESTRATOR] Graceful shutdown başlatıldı (${signal}). Exit code=${exitCode}; restart beklenmiyor.`);
    }

    clearMasterKeyCache();
    clearRuntimeSchedulers();

    const forceExitTimer = setTimeout(() => {
      logger.error(`[ORCHESTRATOR] Shutdown timeout (${FATAL_EXIT_TIMEOUT_MS}ms) aşıldı. process.exit(${exitCode}) zorlanıyor.`);
      process.exit(exitCode);
    }, FATAL_EXIT_TIMEOUT_MS);

    try {
      if (server && server.listening) {
        await new Promise((resolve) => server.close(resolve));
        logger.warn("[ORCHESTRATOR] Yeni istek kabulü durduruldu (server.close).");
      } else {
        logger.warn("[ORCHESTRATOR] HTTP sunucusu henüz dinlemede değil; yeni istek akışı yok.");
      }

      await worker.stop();
      logger.info("[ORCHESTRATOR] Worker stop tamamlandı.");

      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
        logger.info("[ORCHESTRATOR] MongoDB bağlantısı kapatıldı.");
      }

      try {
        const redisClient = getRedisClient();
        if (redisClient?.isOpen) {
          await redisClient.quit();
          logger.info("[ORCHESTRATOR] Redis bağlantısı kapatıldı.");
        }
      } catch (redisErr) {
        logger.warn("[ORCHESTRATOR] Redis kapatma adımı atlandı/başarısız:", { message: redisErr.message });
      }
    } catch (shutdownErr) {
      logger.error("[ORCHESTRATOR] Shutdown sırasında hata oluştu:", {
        message: shutdownErr.message,
        stack: shutdownErr.stack,
      });
    } finally {
      clearTimeout(forceExitTimer);
      logger.warn(`[ORCHESTRATOR] Shutdown tamamlandı. process.exit(${exitCode}) çağrılıyor.`);
      process.exit(exitCode);
    }
  };

  // [TR] Fatal process event'leri orchestration uyumlu şekilde kapatılır.
  // [EN] Fatal process events trigger orchestrator-friendly forced exit semantics.
  process.on("uncaughtException", (err) => {
    shutdown({
      signal: "uncaughtException",
      exitCode: 1,
      reason: { message: err.message, stack: err.stack },
    });
  });
  process.on("unhandledRejection", (reason) => {
    shutdown({
      signal: "unhandledRejection",
      exitCode: 1,
      reason: { reason },
    });
  });

  try {
    // [TR] Production'da SIWE_DOMAIN localhost olamaz
    // [EN] SIWE_DOMAIN cannot be localhost in production
    if (process.env.NODE_ENV === "production") {
      const siweDomain = process.env.SIWE_DOMAIN;
      if (!siweDomain || siweDomain === "localhost") {
        logger.error("[GÜVENLİK] SIWE_DOMAIN production'da 'localhost' olamaz! Gerçek domain ayarlayın.");
        process.exit(1);
      }

      const siweChainId = Number(process.env.SIWE_CHAIN_ID || 0);
      if (!Number.isInteger(siweChainId) || siweChainId <= 0) {
        logger.error("[GÜVENLİK] SIWE_CHAIN_ID production'da zorunlu ve pozitif integer olmalıdır.");
        process.exit(1);
      }
    }

    // [TR] SameSite=None konfigürasyonunda Secure cookie zorunludur.
    // [EN] Secure cookies are mandatory when SameSite=None is configured.
    const cookieSameSite = String(process.env.COOKIE_SAMESITE || "lax").toLowerCase();
    if (cookieSameSite === "none" && process.env.NODE_ENV !== "production") {
      logger.warn("[SECURITY] COOKIE_SAMESITE=none dev ortamında HTTPS gerektirir; local HTTP'de cookie yazımı başarısız olabilir.");
    }

    await connectDB();
    await connectRedis();
    logger.info("MongoDB ve Redis bağlantıları başarıyla sağlandı.");

    await loadProtocolConfig();

    await worker.start();
    logger.info("Event Listener (Zincir Dinleyici) aktif: Base L2 ağı izleniyor.");

    // [TR] DLQ monitörü — her 60 saniyede başarısız event'leri kontrol eder
    // [EN] DLQ monitor — checks failed events every 60 seconds
    dlqInterval = setInterval(processDLQ, 60_000);

    // [TR] İlk çalıştırma 30 sn geciktirilir — cold start'ta DB'ye eş zamanlı yük binmesini önler
    // [EN] First run delayed by 30s — prevents simultaneous DB load on cold start
    reputationDecayDelay = setTimeout(() => {
      runReputationDecay();
      logger.info("Periyodik İtibar İyileştirme görevi zamanlandı (her 24 saatte bir).");
    }, 30_000);
    reputationDecayInterval = setInterval(runReputationDecay, 24 * 60 * 60 * 1000);

    statsSnapshotDelay = setTimeout(() => {
      runStatsSnapshot();
      logger.info("Periyodik İstatistik Kaydetme görevi zamanlandı (her 24 saatte bir).");
    }, 60_000);
    statsSnapshotInterval = setInterval(runStatsSnapshot, 24 * 60 * 60 * 1000);

    // [TR] PENDING listing cleanup — her saat stale kayıtları temizler
    // [EN] PENDING listing cleanup — purges stale records hourly
    pendingCleanupDelay = setTimeout(() => {
      runPendingListingCleanup();
      logger.info("Periyodik PENDING listing temizlik görevi zamanlandı (her 1 saatte bir).");
    }, 90_000);
    pendingCleanupInterval = setInterval(runPendingListingCleanup, 60 * 60 * 1000);

    // [TR] Hassas veri retention cleanup — her 30 dakikada bir
    const sensitiveCleanupDelay = setTimeout(async () => {
      await runReceiptCleanup();
      await runPIISnapshotCleanup();
      logger.info("Receipt/PII retention cleanup görevi zamanlandı (her 30 dakikada bir).");
    }, 120_000);
    const sensitiveCleanupInterval = setInterval(async () => {
      await runReceiptCleanup();
      await runPIISnapshotCleanup();
    }, 30 * 60 * 1000);

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

    app.get("/health", (req, res) => res.json(getLiveness()));
    app.get("/ready", async (req, res) => {
      const readiness = await getReadiness({ worker, provider: worker.provider });
      return res.status(readiness.ok ? 200 : 503).json(readiness);
    });

    app.use((req, res) => res.status(404).json({ error: "İstenen endpoint bulunamadı" }));

    app.use(globalErrorHandler);

    const PORT = process.env.PORT || 4000;
    server = app.listen(PORT, () => {
      logger.info(`===========================================================`);
      logger.info(`🚀 Araf Protocol Backend Dinleniyor: Port ${PORT}`);
      logger.info(`🌍 Ortam: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🛡️  Güvenlik: Non-custodial backend (opsiyonel automation signer olabilir).`);
      logger.info(`===========================================================`);
    });

    process.on("SIGTERM", () => shutdown({ signal: "SIGTERM", exitCode: 0 }));
    process.on("SIGINT",  () => shutdown({ signal: "SIGINT", exitCode: 0 }));

  } catch (err) {
    logger.error("Uygulama başlatılırken kritik hata oluştu:", err);
    process.exit(1);
  }
}

bootstrap();

module.exports = app;
