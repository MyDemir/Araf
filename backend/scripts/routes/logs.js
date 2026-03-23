"use strict";
const express = require("express");
const router = express.Router();
const logger = require("../utils/logger");

/**
 * Client Error Logger - Frontend Hata Yakalayıcı
 * [TR] Frontend'den gelen render ve uygulama hatalarını merkezi logger'a iletir.
 * [EN] Forwards render and application errors from frontend to the central logger.
 */
router.post("/client-error", (req, res) => {
  const { message, stack, componentStack, url } = req.body;

  // Merkezi log dosyasına (araf_full_stack.log.txt) yazar
  logger.error(`[FRONTEND-CRASH]`, {
    message: message || "No message provided",
    url: url || "Unknown URL",
    stack: stack,
    componentStack: componentStack,
    userAgent: req.headers["user-agent"]
  });

  // 204 No Content: Sisteme yük bindirmemek için gövdesiz cevap döner
  res.status(204).end();
});

module.exports = router;
