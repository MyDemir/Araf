"use strict";

const { Listing } = require("../models/Trade");
const logger      = require("../utils/logger");

// [TR] On-chain'e hiç düşmemiş PENDING ilanlar için temizlik eşiği (12 saat)
// [EN] Cleanup threshold for PENDING listings that never reached on-chain (12h)
const PENDING_TTL_MS = 12 * 60 * 60 * 1000;

async function runPendingListingCleanup() {
  try {
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);

    const result = await Listing.updateMany(
      {
        status: "PENDING",
        onchain_escrow_id: null,
        created_at: { $lt: cutoff },
      },
      {
        $set: { status: "DELETED" },
      }
    );

    if (result.modifiedCount > 0) {
      logger.info(`[Job:PendingCleanup] ${result.modifiedCount} eski PENDING ilan DELETED yapıldı.`);
    }
  } catch (err) {
    logger.error(`[Job:PendingCleanup] Temizlik görevi başarısız: ${err.message}`);
  }
}

module.exports = {
  runPendingListingCleanup,
};
