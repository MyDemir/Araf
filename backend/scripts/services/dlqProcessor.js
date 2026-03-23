"use strict";

/**
 * DLQ Processor — Dead Letter Queue Monitor
 *
 * Başarısız event'ler eventListener tarafından Redis DLQ'ya yazılır.
 * Bu servis periyodik olarak DLQ'yu kontrol eder, birikmiş entry'leri loglar
 * ve eşik aşıldığında uyarı verir.
 *
 * app.js tarafından setInterval(processDLQ, 60_000) ile çağrılır.
 *
 * Gelecek: Slack/PagerDuty webhook entegrasyonu için ALERT_WEBHOOK_URL .env'e eklenebilir.
 *
 * - İşlenen entry'ler LTRIM ile kırpılır (max 100 entry tutulur)
 * - Alert cooldown: Aynı uyarı 10 dakikada bir kez gönderilir
 * - Eski entry'ler archive key'ine taşınır (inceleme için)
 */

const { getRedisClient } = require("../config/redis");
const logger             = require("../utils/logger");

const DLQ_KEY           = "worker:dlq";
const DLQ_ARCHIVE_KEY   = "worker:dlq:archive";  // AUDIT FIX B-02: İnceleme için arşiv
const ALERT_THRESHOLD   = 5;    // Bu sayının üzerinde entry varsa uyarı ver
const MAX_DLQ_SIZE      = 100;  // AUDIT FIX B-02: DLQ'da tutulan max entry
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // AUDIT FIX B-02: Alert cooldown (10 dk)

//son alert zamanı — cooldown için bellekte tutulur
let _lastAlertTimestamp = 0;

/**
 * DLQ'yu kontrol eder, loglar, arşivler ve gerekirse kırpar.
 
 * Yeni akış:
 * 1. DLQ uzunluğunu kontrol et
 * 2. MAX_DLQ_SIZE'dan fazlaysa eski entry'leri arşive taşı ve LTRIM ile kırp
 * 3. Son 10 entry'yi logla
 * 4. Eşik aşıldıysa ve cooldown geçtiyse alert ver
 */
async function processDLQ() {
  try {
    const redis  = getRedisClient();
    const length = await redis.lLen(DLQ_KEY);

    if (length === 0) {
      logger.debug("[DLQ] Kuyruk temiz.");
      return;
    }

    logger.warn(`[DLQ] ${length} işlenemeyen event bulundu.`);

    // DLQ boyutu aşıldıysa eski entry'leri arşive taşı
    if (length > MAX_DLQ_SIZE) {
      const overflow = length - MAX_DLQ_SIZE;
      // En eski entry'leri oku (listenin sonundan — lPush ile eklendiği için son = en eski)
      const oldEntries = await redis.lRange(DLQ_KEY, -overflow, -1);

      // Arşive taşı (inceleme için 7 gün tutulur)
      if (oldEntries.length > 0) {
        const multi = redis.multi();
        for (const entry of oldEntries) {
          multi.lPush(DLQ_ARCHIVE_KEY, entry);
        }
        // Arşivi de sınırlı tut (max 1000 entry)
        multi.lTrim(DLQ_ARCHIVE_KEY, 0, 999);
        // Arşivin TTL'si: 7 gün
        multi.expire(DLQ_ARCHIVE_KEY, 7 * 24 * 3600);
        // Ana DLQ'yu kırp — sadece en yeni MAX_DLQ_SIZE entry kalsın
        multi.lTrim(DLQ_KEY, 0, MAX_DLQ_SIZE - 1);
        await multi.exec();

        logger.info(`[DLQ] ${oldEntries.length} eski entry arşive taşındı, DLQ ${MAX_DLQ_SIZE}'a kırpıldı.`);
      }
    }

    // Son 10 entry'yi logla (listeyi boşaltmadan)
    const entries = await redis.lRange(DLQ_KEY, 0, 9);
    for (const raw of entries) {
      try {
        const entry = JSON.parse(raw);
        logger.error(`[DLQ] Event: ${entry.eventName} | tx: ${entry.txHash} | blok: ${entry.blockNumber} | hata: ${entry.error} | zaman: ${entry.timestamp}`);
      } catch {
        logger.error(`[DLQ] Ham entry parse edilemedi: ${raw}`);
      }
    }
    if (entries.length > 0) {
      await redis.lTrim(DLQ_KEY, entries.length, -1);
      logger.info(`[DLQ] ${entries.length} entry loglandı ve DLQ'dan kaldırıldı.`);
    }

    // Alert cooldown — aynı uyarı 10 dakikada bir kez
    if (length >= ALERT_THRESHOLD) {
      const now = Date.now();
      if (now - _lastAlertTimestamp >= ALERT_COOLDOWN_MS) {
        _lastAlertTimestamp = now;
        logger.error(`[DLQ] ⚠ KRİTİK: DLQ'da ${length} event birikti! Manuel müdahale gerekebilir.`);
        // TODO: Slack/PagerDuty webhook gönderimi buraya eklenecek
        // await sendAlert(`DLQ kritik seviye: ${length} işlenemeyen event`);
      }
    }
  } catch (err) {
    // DÜZELTME: Sadece hata mesajını değil, tam yığın izini (stack trace) de dosyaya yazdır.
    logger.error(`[DLQ] Processor hatası: ${err.message}`, { stack: err.stack });
  }
}

module.exports = { processDLQ };
