// ─── config/redis.js ──────────────────────────────────────────────────────────
"use strict";

const { createClient } = require("redis");
const logger = require("../utils/logger");

let redisClient = null;

async function connectRedis() {
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  redisClient = createClient({ url });

  redisClient.on("error",   (err) => logger.error(`[Redis] Error: ${err.message}`));
  redisClient.on("connect", ()    => logger.info("[Redis] Connected"));
  redisClient.on("reconnecting", () => logger.warn("[Redis] Reconnecting..."));

  await redisClient.connect();
}

function getRedisClient() {
  if (!redisClient) throw new Error("Redis not initialized. Call connectRedis() first.");
  return redisClient;
}

module.exports = { connectRedis, getRedisClient };
