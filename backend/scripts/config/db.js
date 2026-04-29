// ─── config/db.js ─────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const logger   = require("../utils/logger");
const {
  updateRuntimeState,
  markDegraded,
  clearDegradedIfReady,
} = require("../services/health");

let isConnected = false;
let handlersRegistered = false;

function registerConnectionHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  mongoose.connection.on("error", (err) => {
    logger.error(`[DB] Bağlantı hatası: ${err.message}`);
    updateRuntimeState({ dbReady: false });
    markDegraded(err);
  });

  mongoose.connection.on("disconnected", () => {
    isConnected = false;
    logger.error("[DB] MongoDB bağlantısı koptu — degraded moda geçiliyor.");
    updateRuntimeState({ dbReady: false });
    markDegraded(new Error("MongoDB disconnected"));
  });

  mongoose.connection.on("connected", () => {
    isConnected = true;
    logger.info("[DB] MongoDB bağlantısı aktif.");
    updateRuntimeState({ dbReady: true, lastStartupError: null });
    clearDegradedIfReady();
  });

  mongoose.connection.on("reconnected", () => {
    isConnected = true;
    logger.info("[DB] MongoDB bağlantısı yeniden kuruldu.");
    updateRuntimeState({ dbReady: true, lastStartupError: null });
    clearDegradedIfReady();
  });
}

/**
 * MongoDB bağlantısını kurar.
 */
async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI ortam değişkeni zorunludur.");

  registerConnectionHandlers();

  await mongoose.connect(uri, {
    maxPoolSize:              100,
    socketTimeoutMS:          45_000,
    serverSelectionTimeoutMS: 10_000,
  });

  isConnected = true;
  updateRuntimeState({ dbReady: true, lastStartupError: null });
  clearDegradedIfReady();

  // [TR] Kimlik bilgilerini loglamaktan kaçın (@ işaretinden sonrasını al)
  logger.info(`[DB] MongoDB bağlantısı kuruldu: ${uri.split("@").pop()}`);
}

module.exports = { connectDB, registerConnectionHandlers };
