"use strict";

/**
 * Stats Route — Protokol İstatistikleri
 *
 * ORTA-13 Fix: İstatistiklerde Matematiksel Yanıltma Düzeltildi.
 *   ÖNCEKİ: calculateChange(current, previous) fonksiyonu previous === 0 ise
 *   doğrudan 100.0 dönüyordu.
 *   Sorun 1: 0→1 işlem de %100, 0→1.000.000 işlem de %100 görünüyordu.
 *   Sorun 2: previous null veya undefined gelirse (current - previous) = NaN → UI bozuluyordu.
 *   ŞİMDİ:
 *     - previous 0 veya null ise "karşılaştırma yapılamaz" anlamında null döner
 *     - Frontend null değeri "— " veya "Yeni" olarak gösterebilir
 *     - Gerçek yüzde değişimi sadece geçerli veri olduğunda hesaplanır
 */

const express = require("express");
const router  = express.Router();

const { getRedisClient } = require("../config/redis");
const logger             = require("../utils/logger");
const HistoricalStat     = require("../models/HistoricalStat");

const STATS_CACHE_KEY = "cache:protocol_stats";
const STATS_CACHE_TTL = 3600; // 1 saat

/**
 * ORTA-13 Fix: Güvenli yüzde değişim hesaplama.
 *
 * @param {number} current  - Güncel değer
 * @param {number} previous - Önceki değer (0, null veya undefined olabilir)
 * @returns {number|null}
 *   - Geçerli karşılaştırma varsa: yüzde değişim (örn: 12.5 = %12.5)
 *   - Karşılaştırma yapılamıyorsa: null
 *     (previous = 0 veya null → "önceki dönem verisi yok" demek)
 */
function calculateChange(current, previous) {
  // [TR] Önceki değer yoksa veya sıfırsa anlamlı karşılaştırma yapılamaz
  if (previous == null || previous === 0) return null;

  // [TR] Güncel değer sayı değilse null döndür
  if (typeof current !== 'number' || isNaN(current)) return null;

  return parseFloat((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
}

// ── GET /api/stats ─────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const redis = getRedisClient();

    // 1. Önbelleği kontrol et
    const cachedStats = await redis.get(STATS_CACHE_KEY);
    if (cachedStats) {
      logger.debug("[Stats] Önbellekten sunuldu.");
      return res.json({ stats: JSON.parse(cachedStats) });
    }

    logger.debug("[Stats] Önbellek boş, yeniden hesaplanıyor...");

    // 2. En son anlık görüntüyü çek
    const currentStatsDoc = await HistoricalStat.findOne().sort({ date: -1 }).lean();
    if (!currentStatsDoc) {
      return res.json({ stats: {} });
    }
    const { _id, date, __v, created_at, ...currentStats } = currentStatsDoc;

    // 3. 30 gün önceki anlık görüntüyü çek
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateString30d = thirtyDaysAgo.toISOString().split('T')[0];

    const oldStats = await HistoricalStat.findOne({ date: dateString30d }).lean();

    // 4. ORTA-13 Fix: Güvenli yüzde değişim hesaplama
    const changes_30d = {};
    if (oldStats) {
      changes_30d.total_volume_usdt_pct = calculateChange(
        currentStats.total_volume_usdt,
        oldStats.total_volume_usdt
      );
      changes_30d.completed_trades_pct = calculateChange(
        currentStats.completed_trades,
        oldStats.completed_trades
      );
      changes_30d.active_listings_pct = calculateChange(
        currentStats.active_listings,
        oldStats.active_listings
      );
      changes_30d.burned_bonds_usdt_pct = calculateChange(
        currentStats.burned_bonds_usdt,
        oldStats.burned_bonds_usdt
      );
      // [TR] null = "önceki dönem verisi yok / karşılaştırma yapılamaz"
      // Frontend null'ı "—" veya "Yeni" olarak göstermeli
    }

    const finalStats = { ...currentStats, changes_30d };

    // 5. Önbelleğe al ve döndür
    await redis.setEx(STATS_CACHE_KEY, STATS_CACHE_TTL, JSON.stringify(finalStats));

    return res.json({ stats: finalStats });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
