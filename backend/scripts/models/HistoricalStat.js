"use strict";

/**
 * HistoricalStat Model — Günlük Protokol İstatistikleri Anlık Görüntüsü
 *
 * Bu koleksiyon, her günün sonunda o günkü toplam metrikleri saklar.
 * /api/stats endpoint'i, 30 gün önceki veriyle karşılaştırma yaparak
 * yüzde değişimlerini verimli bir şekilde hesaplamak için bu koleksiyonu kullanır.
 *
 */

const mongoose = require("mongoose");

const historicalStatSchema = new mongoose.Schema({
  // Tarih (YYYY-MM-DD formatında) — benzersiz anahtar
  date: {
    type: String,
    required: true,
    unique: true,
    match: /^\d{4}-\d{2}-\d{2}$/,
  },
  total_volume_usdt: { type: Number, required: true, default: 0 },
  completed_trades:  { type: Number, required: true, default: 0 },
  active_listings:   { type: Number, required: true, default: 0 },
  burned_bonds_usdt: { type: Number, required: true, default: 0 },
  // AFS-025 Fix: Ortalama işlem süresi (saat cinsinden) — statsSnapshot tarafından hesaplanır
  avg_trade_hours:   { type: Number, default: null },
}, {
  timestamps: { createdAt: "created_at", updatedAt: false }, // Sadece oluşturulma tarihi
  collection: "historical_stats",
});

// Tarih alanına descending index — stats route'unda .sort({ date: -1 }) performansı
historicalStatSchema.index({ date: -1 });

const HistoricalStat = mongoose.model("HistoricalStat", historicalStatSchema);

module.exports = HistoricalStat;
