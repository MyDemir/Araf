// ─── config/redis.js ──────────────────────────────────────────────────────────
"use strict";

const { createClient } = require("redis");
const logger = require("../utils/logger");

let redisClient = null;

/**
 * Redis bağlantısını kurar.
 *
 * ALT-02 Fix: Rate Limiter için Tek Nokta Hatası ortadan kaldırıldı.
 *   isReady() fonksiyonu eklendi. rateLimiter.js bu fonksiyonu
 *   kontrol ederek Redis erişilemezse fail-open davranışına geçiyor.
 *
 * ALT-03 Fix: Üretim TLS desteği eklendi.
 *   REDIS_URL'de "rediss://" prefix'i varsa otomatik TLS aktif.
 *   REDIS_TLS_SKIP_VERIFY=true ile self-signed sertifikaları da destekleniyor
 *   (sadece geliştirme için — production'da kullanmayın).
 */
async function connectRedis() {
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";

  // ALT-03 Fix: TLS desteği — rediss:// prefix'i veya REDIS_TLS=true
  const useTLS = url.startsWith("rediss://") || process.env.REDIS_TLS === "true";

  const clientOptions = { url };

  if (useTLS) {
    clientOptions.socket = {
      tls: true,
      // [TR] REDIS_TLS_SKIP_VERIFY sadece self-signed sertifikaları olan
      // geliştirme ortamları için. PRODUCTION'DA KULLANMAYIN.
      rejectUnauthorized: process.env.REDIS_TLS_SKIP_VERIFY !== "true",
    };
    logger.info("[Redis] TLS modu aktif.");
  }

  redisClient = createClient(clientOptions);

  redisClient.on("error",        (err) => logger.error(`[Redis] Hata: ${err.message}`));
  redisClient.on("connect",      ()    => logger.info("[Redis] Bağlantı kuruldu."));
  redisClient.on("reconnecting", ()    => logger.warn("[Redis] Yeniden bağlanıyor..."));
  redisClient.on("ready",        ()    => logger.info("[Redis] Hazır."));

  await redisClient.connect();
}

function getRedisClient() {
  if (!redisClient) {
    throw new Error("Redis başlatılmamış. Önce connectRedis() çağrılmalı.");
  }
  return redisClient;
}

/**
 * ALT-02 Fix: Redis'in kullanıma hazır olup olmadığını kontrol eder.
 * rateLimiter.js bu fonksiyonu kullanarak Redis erişilemezse
 * rate limiting'i atlayabilir (fail-open) — platform erişilemez olmasın.
 *
 * @returns {boolean} Redis bağlı ve hazırsa true
 */
function isReady() {
  try {
    return redisClient?.isReady === true;
  } catch {
    return false;
  }
}

module.exports = { connectRedis, getRedisClient, isReady };
