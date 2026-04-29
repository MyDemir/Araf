"use strict";

/*
## rateLimiter.js hardening

This PR updates `backend/scripts/middleware/rateLimiter.js` to preserve the previous Redis degradation strategy for general endpoints while introducing stricter protection for the auth surface.

### Previous behavior
The limiter used a single Redis availability strategy for all routes:

- if Redis was unavailable, `makeSkipFn()` skipped rate limiting entirely
- this kept the platform reachable
- but it also made auth endpoints effectively fail-open

That meant `/nonce`, `/verify`, and `/refresh` could become temporarily unprotected during Redis outages.

### Existing fix that remains
The earlier fix for proxy/load-balancer environments still stands:

- rate limit keys are still based on `req.ip`
- this assumes `trust proxy` is correctly enabled in `app.js`
- without that, all users behind the same proxy/load balancer could collapse into one IP bucket

That part is preserved and not changed here.

### New behavior
This PR keeps fail-open behavior for general/public routes, but separates auth from that policy.

New behavior:

- public and lower-risk routes still use the general Redis-based skip strategy
- auth routes now use a dedicated fallback path when Redis is unavailable
- an in-memory limiter is introduced for auth traffic
- if Redis is down, auth requests are no longer fully unbounded
- if the in-memory auth limit is exceeded, the request is rejected with `429`

### Effect
This keeps the original availability goal for the wider platform while preventing the auth surface from becoming completely unprotected during Redis degradation.

### Scope
Only `backend/scripts/middleware/rateLimiter.js` was targeted here.
*/

const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { getRedisClient, isReady } = require("../config/redis");
const logger = require("../utils/logger");

/**
 * Redis store oluşturur.
 */
function makeStore(prefix) {
  if (!isReady()) return undefined;
  try {
    const client = getRedisClient();
    if (!client?.isReady) return undefined;
    return new RedisStore({
      sendCommand: (...args) => client.sendCommand(args),
      prefix: `rl:${prefix}:`,
    });
  } catch (err) {
    logger.warn(`[RateLimit] Redis store oluşturulamadı (${prefix}): ${err.message}`);
    return undefined;
  }
}

/**
 * Genel endpoint'ler için Redis yoksa limiter geçici olarak devre dışı kalır.
 * Bu tercih public/read ağırlıklı yüzeylerde erişilebilirliği korur.
 */
function makeSkipFn() {
  return () => {
    if (!isReady()) {
      logger.warn("[RateLimit] Redis erişilemez — rate limiting geçici olarak devre dışı (fail-open).");
      return true;
    }
    return false;
  };
}

/**
 * Auth endpoint'leri için Redis yoksa in-memory fallback kullanılır.
 * Böylece auth yüzeyi tamamen korumasız kalmaz.
 */
const _authInMemory = new Map(); // key -> { count, resetAt }
const AUTH_INMEM_MAX = 10;
const AUTH_INMEM_WINDOW = 60_000; // 1 dakika

function _authInMemoryCheck(key) {
  const now = Date.now();
  const entry = _authInMemory.get(key);

  if (!entry || now > entry.resetAt) {
    _authInMemory.set(key, { count: 1, resetAt: now + AUTH_INMEM_WINDOW });
    return false;
  }

  entry.count += 1;
  if (entry.count > AUTH_INMEM_MAX) {
    return true;
  }
  return false;
}

// Eski in-memory kayıtları temizler.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _authInMemory.entries()) {
    if (now > entry.resetAt) _authInMemory.delete(key);
  }
}, 5 * 60_000);

/**
 * Auth yüzeyi için Redis yoksa istekleri tamamen serbest bırakmayız.
 * Limit aşılırsa burada doğrudan 429 döneriz.
 */
function makeAuthSkipFn() {
  return (req, res) => {
    if (isReady()) {
      return false;
    }

    const key = req.ip;
    const blocked = _authInMemoryCheck(key);

    if (blocked) {
      logger.warn(`[RateLimit:AUTH-FALLBACK] In-memory limit aşıldı: ${req.ip}`);
      res.status(429).json({
        error: "Çok fazla auth isteği. 1 dakika sonra tekrar deneyin.",
      });
      return true;
    }

    logger.warn("[RateLimit:AUTH] Redis erişilemez — in-memory fallback aktif.");
    return false;
  };
}

function onLimitReached(req) {
  logger.warn(
    `[RateLimit] Engellendi: ${req.ip} | ${req.path} | wallet: ${req.wallet || "anon"}`
  );
}

// ─── PII / IBAN Endpoint — En Sıkı ───────────────────────────────────────────
// 10 dakikada 3 istek — IP + wallet kombinasyonu
const piiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `${req.ip}:${req.wallet || "anon"}`,
  store: makeStore("pii"),
  skip: makeSkipFn(),
  handler: (req, res) => {
    onLimitReached(req);
    res.status(429).json({
      error: "Çok fazla PII isteği. 10 dakikada maksimum 3 istek.",
      retryAfter: Math.ceil(10 * 60),
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── SIWE Auth — Brute Force Koruması ────────────────────────────────────────
// 1 dakikada 10 istek — IP bazlı
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
  store: makeStore("auth"),
  skip: makeAuthSkipFn(),
  handler: (req, res) => {
    onLimitReached(req);
    res.status(429).json({ error: "Çok fazla auth isteği. 1 dakika sonra tekrar deneyin." });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Listings GET — Public Okuma ──────────────────────────────────────────────
// 1 dakikada 100 istek — IP bazlı
const listingsReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.ip,
  store: makeStore("listings-read"),
  skip: makeSkipFn(),
  handler: (req, res) => {
    onLimitReached(req);
    res.status(429).json({ error: "Çok fazla istek. Yavaşlayın." });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Listings POST — İlan Oluşturma ──────────────────────────────────────────
// Saatte 5 istek — wallet bazlı
const listingsWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.wallet || req.ip,
  store: makeStore("listings-write"),
  skip: makeSkipFn(),
  handler: (req, res) => {
    onLimitReached(req);
    res.status(429).json({ error: "İlan oluşturma limiti: Saatte 5 istek." });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Trades — İşlem Odası & İptal İşlemleri ──────────────────────────────────
// 1 dakikada 30 istek — wallet bazlı
const tradesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.wallet || req.ip,
  store: makeStore("trades"),
  skip: makeSkipFn(),
  handler: (req, res) => {
    onLimitReached(req);
    res.status(429).json({ error: "Çok fazla trade isteği. Dakikada maksimum 30 istek." });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Feedback — Spam Engeli ───────────────────────────────────────────────────
// Saatte 3 istek — wallet bazlı
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.wallet || req.ip,
  store: makeStore("feedback"),
  skip: makeSkipFn(),
  handler: (req, res) => {
    onLimitReached(req);
    res.status(429).json({ error: "Geri bildirim limiti: Saatte 3 istek." });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  piiLimiter,
  authLimiter,
  listingsReadLimiter,
  listingsWriteLimiter,
  tradesLimiter,
  feedbackLimiter,
};
