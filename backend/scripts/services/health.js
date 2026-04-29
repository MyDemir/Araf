"use strict";

const mongoose = require("mongoose");
const { isReady: isRedisReady, getRedisClient } = require("../config/redis");

const CHECKPOINT_KEY = "worker:last_block";
const LAST_SAFE_BLOCK_KEY = "worker:last_safe_block";
const MAX_WORKER_LAG_BLOCKS = Number(process.env.WORKER_MAX_LAG_BLOCKS || 25);
const HEALTH_PROVIDER_BLOCK_CACHE_MS = Number(process.env.HEALTH_PROVIDER_BLOCK_CACHE_MS || 15000);

const providerReadinessCache = { lastCheckedAt: 0, lastCurrentBlock: null, lastProviderReady: false };

const runtimeState = {
  serverListening: false,
  dbReady: false,
  redisReady: false,
  protocolConfigReady: false,
  workerReady: false,
  degraded: false,
  lastStartupError: null,
  lastWorkerError: null,
};

const updateRuntimeState = (patch = {}) => Object.assign(runtimeState, patch);
const markDegraded = (err, { worker = false } = {}) => {
  runtimeState.degraded = true;
  const detail = { message: err?.message || String(err), at: new Date().toISOString() };
  if (worker) runtimeState.lastWorkerError = detail;
  else runtimeState.lastStartupError = detail;
};
const clearDegradedIfReady = () => {
  const allReady = runtimeState.serverListening && runtimeState.dbReady && runtimeState.redisReady && runtimeState.protocolConfigReady && runtimeState.workerReady;
  if (allReady) runtimeState.degraded = false;
};

async function getReadiness({ worker, provider } = {}) {
  const isProduction = process.env.NODE_ENV === "production";
  const mongoReady = mongoose.connection.readyState === 1;
  const redisReady = isRedisReady();
  const workerRunning = Boolean(worker?.isRunning);

  let providerReady = false;
  let currentBlock = null;
  try {
    if (provider) {
      const now = Date.now();
      if (now - providerReadinessCache.lastCheckedAt < HEALTH_PROVIDER_BLOCK_CACHE_MS) {
        currentBlock = providerReadinessCache.lastCurrentBlock;
        providerReady = providerReadinessCache.lastProviderReady;
      } else {
        currentBlock = await provider.getBlockNumber();
        providerReady = Number.isInteger(currentBlock);
        providerReadinessCache.lastCheckedAt = now;
        providerReadinessCache.lastCurrentBlock = currentBlock;
        providerReadinessCache.lastProviderReady = providerReady;
      }
    } else {
      providerReady = Boolean(worker?.provider);
    }
  } catch {
    providerReady = false;
    providerReadinessCache.lastCheckedAt = Date.now();
    providerReadinessCache.lastCurrentBlock = null;
    providerReadinessCache.lastProviderReady = false;
  }

  const requiredConfig = ["MONGODB_URI", "REDIS_URL", "JWT_SECRET", "SIWE_DOMAIN"];
  if (isProduction) requiredConfig.push("SIWE_URI", "SIWE_CHAIN_ID", "ARAF_ESCROW_ADDRESS", "BASE_RPC_URL");
  const missingConfig = requiredConfig.filter((key) => !process.env[key]);

  let replayBootstrapReady = true;
  if (isProduction) {
    const configuredStartRaw = process.env.ARAF_DEPLOYMENT_BLOCK ?? process.env.WORKER_START_BLOCK;
    const hasConfiguredStart = configuredStartRaw !== undefined && configuredStartRaw !== null && configuredStartRaw !== "";
    let hasCheckpoint = false;
    try {
      const redis = getRedisClient();
      const savedBlock = await redis.get(LAST_SAFE_BLOCK_KEY) ?? await redis.get(CHECKPOINT_KEY);
      hasCheckpoint = savedBlock !== null && savedBlock !== undefined && savedBlock !== "";
    } catch {}
    replayBootstrapReady = hasCheckpoint || hasConfiguredStart;
    if (!replayBootstrapReady) missingConfig.push("ARAF_DEPLOYMENT_BLOCK_OR_WORKER_START_BLOCK_OR_CHECKPOINT");
  }

  const configReady = missingConfig.length === 0;
  const workerState = worker?._state || "unknown";
  const lastSeenBlock = Number.isInteger(worker?._lastSeenBlock) ? worker._lastSeenBlock : null;
  const lastSafeBlock = Number.isInteger(worker?._lastSafeCheckpointBlock) ? worker._lastSafeCheckpointBlock : null;
  let workerLagBlocks = null;
  if (Number.isInteger(currentBlock) && Number.isInteger(lastSafeBlock)) workerLagBlocks = Math.max(0, currentBlock - lastSafeBlock);
  else if (Number.isInteger(currentBlock) && Number.isInteger(lastSeenBlock)) workerLagBlocks = Math.max(0, currentBlock - lastSeenBlock);

  const workerStateHealthy = workerRunning && !["stopped", "reconnecting", "degraded"].includes(workerState);
  const workerLagHealthy = workerLagBlocks === null ? workerStateHealthy : workerLagBlocks <= MAX_WORKER_LAG_BLOCKS;
  const workerReplayHealthy = workerState !== "replaying";
  const workerReady = workerRunning && workerStateHealthy && workerLagHealthy && workerReplayHealthy;

  const ok = (
    runtimeState.serverListening &&
    mongoReady && redisReady && providerReady && configReady && replayBootstrapReady && workerReady &&
    runtimeState.dbReady && runtimeState.redisReady && runtimeState.protocolConfigReady && runtimeState.workerReady &&
    !runtimeState.degraded
  );

  return {
    ok,
    runtime: { ...runtimeState },
    checks: { mongo: mongoReady, redis: redisReady, provider: providerReady, config: configReady, replayBootstrap: replayBootstrapReady, worker: workerReady },
    worker: { state: workerState, currentBlock, lastSeenBlock, lastSafeBlock, lagBlocks: workerLagBlocks, maxAllowedLagBlocks: MAX_WORKER_LAG_BLOCKS },
    missingConfig,
  };
}

function getLiveness() { return { status: "ok", timestamp: new Date().toISOString() }; }

module.exports = { getReadiness, getLiveness, updateRuntimeState, markDegraded, clearDegradedIfReady };
