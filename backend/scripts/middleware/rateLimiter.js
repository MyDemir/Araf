"use strict";

/**
 * Rate Limiting — Redis Sliding Window
 * Different limits for different endpoint sensitivity levels.
 */

const rateLimit      = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { getRedisClient } = require("../config/redis");
const logger         = require("../utils/logger");

function makeStore(prefix) {
  return new RedisStore({
    sendCommand: (...args) => getRedisClient().sendCommand(args),
    prefix:      `rl:${prefix}:`,
  });
}

function onLimitReached(req, res, options) {
  logger.warn(`[RateLimit] Blocked: ${req.ip} | ${req.path} | wallet: ${req.wallet || "anon"}`);
}

// ─── PII / IBAN Endpoint — Strictest ─────────────────────────────────────────
// 3 requests per 10 minutes per IP + wallet combo
const piiLimiter = rateLimit({
  windowMs:         10 * 60 * 1000,
  max:              3,
  keyGenerator:     (req) => `${req.ip}:${req.wallet || "anon"}`,
  store:            makeStore("pii"),
  handler:          (req, res) => {
    onLimitReached(req, res);
    res.status(429).json({
      error: "Too many PII requests. Max 3 per 10 minutes.",
      retryAfter: Math.ceil(10 * 60),
    });
  },
  standardHeaders:  true,
  legacyHeaders:    false,
});

// ─── SIWE Auth — Prevents brute force ────────────────────────────────────────
// 10 requests per minute per IP
const authLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              10,
  keyGenerator:     (req) => req.ip,
  store:            makeStore("auth"),
  handler:          (req, res) => {
    onLimitReached(req, res);
    res.status(429).json({ error: "Too many auth requests. Try again in 1 minute." });
  },
  standardHeaders:  true,
  legacyHeaders:    false,
});

// ─── Listings GET — Public read ───────────────────────────────────────────────
// 100 requests per minute per IP
const listingsReadLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             100,
  keyGenerator:    (req) => req.ip,
  store:           makeStore("listings-read"),
  handler:         (req, res) => {
    onLimitReached(req, res);
    res.status(429).json({ error: "Too many requests. Slow down." });
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ─── Listings POST — Create listing ──────────────────────────────────────────
// 5 per hour per wallet (prevents spam listings)
const listingsWriteLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             5,
  keyGenerator:    (req) => req.wallet || req.ip,
  store:           makeStore("listings-write"),
  handler:         (req, res) => {
    onLimitReached(req, res);
    res.status(429).json({ error: "Listing creation limit: 5 per hour." });
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ─── Trades — Active trade room & cancel operations ───────────────────────────
// 30 requests per minute per wallet (trade room polling, propose-cancel, chargeback-ack)
const tradesLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             30,
  keyGenerator:    (req) => req.wallet || req.ip,
  store:           makeStore("trades"),
  handler:         (req, res) => {
    onLimitReached(req, res);
    res.status(429).json({ error: "Too many trade requests. Max 30 per minute." });
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ─── Feedback — Prevent spam ──────────────────────────────────────────────────
// 3 per hour per wallet
const feedbackLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             3,
  keyGenerator:    (req) => req.wallet || req.ip,
  store:           makeStore("feedback"),
  handler:         (req, res) => {
    onLimitReached(req, res);
    res.status(429).json({ error: "Feedback limit: 3 per hour." });
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

module.exports = {
  piiLimiter,
  authLimiter,
  listingsReadLimiter,
  listingsWriteLimiter,
  tradesLimiter,
  feedbackLimiter,
};
