"use strict";

require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const mongoSanitize = require("express-mongo-sanitize");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");

const { connectDB } = require("./config/db");
const { connectRedis, getRedisClient } = require("./config/redis");
const logger = require("./utils/logger");
const worker = require("./services/eventListener");
const { loadProtocolConfig } = require("./services/protocolConfig");
const { processDLQ } = require("./services/dlqProcessor");
const { runReputationDecay } = require("./jobs/reputationDecay");
const { runStatsSnapshot } = require("./jobs/statsSnapshot");
const { runPendingListingCleanup } = require("./jobs/cleanupPendingListings");
const { getReadiness, getLiveness, updateRuntimeState, markDegraded, clearDegradedIfReady } = require("./services/health");
const { runReceiptCleanup, runPIISnapshotCleanup } = require("./jobs/cleanupSensitiveData");
const { globalErrorHandler } = require("./middleware/errorHandler");
const { clearMasterKeyCache } = require("./services/encryption");

const app = express();
let server = null;
let isShuttingDown = false;
const FATAL_EXIT_TIMEOUT_MS = 8_000;

let dlqInterval = null;
let reputationDecayDelay = null;
let reputationDecayInterval = null;
let statsSnapshotDelay = null;
let statsSnapshotInterval = null;
let pendingCleanupDelay = null;
let pendingCleanupInterval = null;
let sensitiveCleanupDelay = null;
let sensitiveCleanupInterval = null;

app.set("trust proxy", 1);
app.use(helmet({ frameguard: false }));
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173").split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins, credentials: true, methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json({ limit: "50kb" }));
app.use(cookieParser());
app.use(mongoSanitize({ replaceWith: "_", onSanitize: ({ key }) => logger.warn(`[GÜVENLİK] Mongo injection denemesi engellendi: ${key}`) }));

// [TR] Fly health-check için liveness/readiness route'ları startup sırasında register edilir.
app.get("/health", (req, res) => res.status(200).json(getLiveness()));
app.get("/ready", async (req, res) => {
  const readiness = await getReadiness({ worker, provider: worker.provider });
  return res.status(readiness.ok ? 200 : 503).json(readiness);
});

const logRoutes = require("./routes/logs");
const authRoutes = require("./routes/auth");
const listingRoutes = require("./routes/listings");
const tradeRoutes = require("./routes/trades");
const piiRoutes = require("./routes/pii");
const feedbackRoutes = require("./routes/feedback");
const statsRoutes = require("./routes/stats");
const receiptRoutes = require("./routes/receipts");
app.use("/api/logs", logRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/pii", piiRoutes);
app.use("/api/feedback", feedbackRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/receipts", receiptRoutes);
app.use((req, res) => res.status(404).json({ error: "İstenen endpoint bulunamadı" }));
app.use(globalErrorHandler);

function clearRuntimeSchedulers() {
  if (dlqInterval) clearInterval(dlqInterval);
  if (reputationDecayDelay) clearTimeout(reputationDecayDelay);
  if (reputationDecayInterval) clearInterval(reputationDecayInterval);
  if (statsSnapshotDelay) clearTimeout(statsSnapshotDelay);
  if (statsSnapshotInterval) clearInterval(statsSnapshotInterval);
  if (pendingCleanupDelay) clearTimeout(pendingCleanupDelay);
  if (pendingCleanupInterval) clearInterval(pendingCleanupInterval);
  if (sensitiveCleanupDelay) clearTimeout(sensitiveCleanupDelay);
  if (sensitiveCleanupInterval) clearInterval(sensitiveCleanupInterval);
}

function startSchedulers() {
  dlqInterval = setInterval(processDLQ, 60_000);
  reputationDecayDelay = setTimeout(() => runReputationDecay(), 30_000);
  reputationDecayInterval = setInterval(runReputationDecay, 24 * 60 * 60 * 1000);
  statsSnapshotDelay = setTimeout(() => runStatsSnapshot(), 60_000);
  statsSnapshotInterval = setInterval(runStatsSnapshot, 24 * 60 * 60 * 1000);
  pendingCleanupDelay = setTimeout(() => runPendingListingCleanup(), 90_000);
  pendingCleanupInterval = setInterval(runPendingListingCleanup, 60 * 60 * 1000);
  sensitiveCleanupDelay = setTimeout(async () => { await runReceiptCleanup(); await runPIISnapshotCleanup(); }, 120_000);
  sensitiveCleanupInterval = setInterval(async () => { await runReceiptCleanup(); await runPIISnapshotCleanup(); }, 30 * 60 * 1000);
}

async function startWorkerWithRetry() {
  const backoffs = [5000, 15000, 30000, 60000, 300000];
  let attempt = 0;
  while (!isShuttingDown) {
    try {
      await worker.start();
      updateRuntimeState({ workerReady: true, lastWorkerError: null });
      clearDegradedIfReady();
      return;
    } catch (err) {
      const waitMs = backoffs[Math.min(attempt, backoffs.length - 1)];
      attempt += 1;
      updateRuntimeState({ workerReady: false });
      markDegraded(err, { worker: true });
      logger.error(`[BOOT] worker.start başarısız, retry ${waitMs}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function startDependencyBootstrap() {
  try { await connectDB(); updateRuntimeState({ dbReady: true }); } catch (err) { updateRuntimeState({ dbReady: false }); markDegraded(err); }
  try { await connectRedis(); updateRuntimeState({ redisReady: true }); } catch (err) { updateRuntimeState({ redisReady: false }); markDegraded(err); }

  try {
    const config = await loadProtocolConfig();
    updateRuntimeState({ protocolConfigReady: Boolean(config) });
    if (!config) markDegraded(new Error("Protocol config unavailable"));
  } catch (err) {
    updateRuntimeState({ protocolConfigReady: false });
    markDegraded(err);
  }

  if (updateRuntimeState && getRedisClient && mongoose.connection.readyState === 1) startSchedulers();
  await startWorkerWithRetry();
}

async function shutdown({ signal = "UNKNOWN", exitCode = 0, reason = null }) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearMasterKeyCache();
  clearRuntimeSchedulers();
  const forceExitTimer = setTimeout(() => process.exit(exitCode), FATAL_EXIT_TIMEOUT_MS);
  try {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await worker.stop();
    if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
    const redisClient = getRedisClient();
    if (redisClient?.isOpen) await redisClient.quit();
  } catch (err) {
    logger.error("[ORCHESTRATOR] Shutdown sırasında hata oluştu:", err);
  } finally {
    clearTimeout(forceExitTimer);
    if (reason) logger.error(`[${signal}]`, reason);
    process.exit(exitCode);
  }
}

process.on("uncaughtException", (err) => shutdown({ signal: "uncaughtException", exitCode: 1, reason: err }));
process.on("unhandledRejection", (reason) => shutdown({ signal: "unhandledRejection", exitCode: 1, reason }));
process.on("SIGTERM", () => shutdown({ signal: "SIGTERM", exitCode: 0 }));
process.on("SIGINT", () => shutdown({ signal: "SIGINT", exitCode: 0 }));

const PORT = process.env.PORT || 4000;
server = app.listen(PORT, () => {
  updateRuntimeState({ serverListening: true });
  logger.info(`🚀 Araf Protocol Backend Dinleniyor: Port ${PORT}`);
  startDependencyBootstrap().catch((err) => markDegraded(err));
});

module.exports = app;
