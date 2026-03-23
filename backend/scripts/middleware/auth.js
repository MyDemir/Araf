"use strict";

const { verifyJWT } = require("../services/siwe");
const logger        = require("../utils/logger");

/**
 * JWT artık httpOnly cookie'den okunuyor.
 *
 * ŞİMDİ: Önce httpOnly cookie kontrol edilir, bulunamazsa header'a fallback yapılır.
 *   Bu sayede JWT JavaScript'ten erişilemez (XSS koruması).
 *
 * NOT: requirePIIToken DEĞİŞMEDİ — PII token trade-scoped ve kısa ömürlü,
 * cookie'de saklanması uygun değil. Bearer header ile gönderilmeye devam eder.
 */

/**
 * @private
 * Helper to extract and verify JWT.
 */
function _getTokenPayload(req) {
  // Önce httpOnly cookie'den oku
  let token = req.cookies?.araf_jwt;

  // Fallback: Authorization header (geriye uyumlu + PII dışındaki manuel çağrılar için)
  if (!token) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      const err = new Error("Authorization header missing");
      err.statusCode = 401;
      throw err;
    }
    token = authHeader.slice(7);
  }

  // verifyJWT will throw its own error if token is invalid/expired
  return verifyJWT(token);
}

/**
 * @private
 * Helper specifically for PII tokens — ALWAYS reads from Authorization header.
 * PII tokens are trade-scoped and short-lived, they should NOT be in cookies.
 */
function _getPIITokenPayload(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    const err = new Error("PII Authorization header missing");
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.slice(7);
  return verifyJWT(token);
}

/**
 * requireAuth — Validates JWT on protected routes.
 * Reads from httpOnly cookie first, then Authorization header.
 * Sets req.wallet = lowercase Ethereum address.
 */
function requireAuth(req, res, next) {
  try {
    const payload = _getTokenPayload(req);

    if (payload.type !== "auth") {
      return res.status(403).json({ error: "Geçersiz token tipi. 'auth' bekleniyordu." });
    }

    req.wallet = payload.sub.toLowerCase();
    next();
  } catch (err) {
    logger.warn(`[Auth] Token verification failed: ${err.message}`);
    return res.status(err.statusCode || 401).json({ error: err.message || "Invalid or expired token" });
  }
}

/**
 * NOT DEĞİŞTİ: PII token her zaman Authorization: Bearer header'ından okunur.
 * PII token cookie'de SAKLANMAMALI — trade-scoped ve kısa ömürlü.
 */
function requirePIIToken(req, res, next) {
  try {
    const payload = _getPIITokenPayload(req);

    // Must be PII-type token
    if (payload.type !== "pii") {
      return res.status(403).json({ error: "Geçersiz token tipi. 'pii' bekleniyordu." });
    }

    // Token must match the requested tradeId
    if (payload.tradeId !== req.params.tradeId) {
      logger.warn(`[GÜVENLİK] PII token manipülasyonu denemesi: caller=${payload.sub}, token_trade=${payload.tradeId}, requested_trade=${req.params.tradeId}`);
      return res.status(403).json({ error: "Token bu işlem için geçerli değil." });
    }

    req.wallet  = payload.sub.toLowerCase();
    next();
  } catch (err) {
    logger.warn(`[PIIAuth] Token verification failed: ${err.message}`);
    return res.status(err.statusCode || 401).json({ error: err.message || "Invalid or expired PII token" });
  }
}

module.exports = { requireAuth, requirePIIToken };
