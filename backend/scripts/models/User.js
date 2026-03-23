"use strict";

const mongoose = require("mongoose");

/**
 * User Model
 *
 * Security design:
 *   - pii_data fields stored as AES-256-GCM ciphertext (never plaintext)
 *   - reputation_cache is READ-ONLY display data; never used for authorization
 *   - nonces NOT stored here — they live in Redis with TTL
 */
const userSchema = new mongoose.Schema(
  {
    wallet_address: {
      type:      String,
      required:  true,
      unique:    true,
      lowercase: true,
      match:     /^0x[a-fA-F0-9]{40}$/, // Valid Ethereum address
      index:     true,
    },

    // ── Encrypted PII (AES-256-GCM) ──────────────────────────────────────────
    // Raw values NEVER stored. Encrypted at service layer before saving.
    pii_data: {
      bankOwner_enc: { type: String, default: null },
      iban_enc:      { type: String, default: null },
      telegram_enc:  { type: String, default: null },
    },

    // ── Reputation Cache (display only — NOT authoritative) ──────────────────
    // Real reputation lives on-chain. This cache is for fast UI rendering only.
    // MUST NOT be used for tier/bond authorization decisions.
    reputation_cache: {
      success_rate:    { type: Number, default: 100, min: 0, max: 100 },
      total_trades:    { type: Number, default: 0,   min: 0 },
      failed_disputes: { type: Number, default: 0,   min: 0 },
      // YENİ: Ağırlıklı başarısızlık puanı. 'burned' gibi ciddi olaylar daha yüksek puana sahiptir.
      failure_score:   { type: Number, default: 0,   min: 0 },
    },

    // YENİ: Başarısızlıkların zamanla etkisini yitirmesi için tutulan geçmiş kaydı.
    // Örnek: [{ type: 'burned', score: 50, date: '...', tradeId: 123 }]
    reputation_history: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },

    // ── Ban Status (mirrors on-chain, refreshed by event listener) ───────────
    is_banned:    { type: Boolean, default: false },
    banned_until: { type: Date,    default: null  },

    // Contract: her yeni ban consecutiveBans++ yapar, 2. ban'dan itibaren tier demosyon uygular.
    // Bu alanlar display/cache amaçlıdır; autoritative değer on-chain'dedir.
    consecutive_bans:  { type: Number, default: 0, min: 0 },
    max_allowed_tier:  { type: Number, default: 4, min: 0, max: 4 },

    // ── Activity ──────────────────────────────────────────────────────────────
    last_login: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    versionKey: false,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
userSchema.index({ wallet_address: 1 });
userSchema.index({ is_banned: 1 });
// TTL index: remove inactive users after 2 years (GDPR compliance)
userSchema.index({ last_login: 1 }, { expireAfterSeconds: 2 * 365 * 24 * 3600 });

// ── Methods ───────────────────────────────────────────────────────────────────

/**
 * Returns safe public profile (no PII, no encrypted fields).
 */
userSchema.methods.toPublicProfile = function () {
  return {
    wallet_address:    this.wallet_address,
    // Fail-safe yaklaşım: Sadece public olması gereken alanları açıkça belirt.
    // Bu, gelecekte eklenecek yeni alanların yanlışlıkla sızmasını engeller.
    reputation_cache:  {
      success_rate:    this.reputation_cache.success_rate,
      total_trades:    this.reputation_cache.total_trades,
      failed_disputes: this.reputation_cache.failed_disputes,
      failure_score:   this.reputation_cache.failure_score,
    },
    is_banned:         this.is_banned,
    //Consecutive ban durumu ve tier kısıtı frontend'e iletilir (display only).
    consecutive_bans:  this.consecutive_bans,
    max_allowed_tier:  this.max_allowed_tier,
    created_at:        this.created_at,
  };
};

/**
 * Check if user's ban has expired (lazily lifts ban).
 */
userSchema.methods.checkBanExpiry = function () {
  if (this.is_banned && this.banned_until && new Date() > this.banned_until) {
    this.is_banned    = false;
    this.banned_until = null;
    return true; // Ban was lifted
  }
  return false;
};

module.exports = mongoose.model("User", userSchema);
