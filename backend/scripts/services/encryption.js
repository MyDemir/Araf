"use strict";

/**
 * ArafEncryption - Envelope Encryption for PII.
 *
 * KMS policy:
 * - development/local: KMS_PROVIDER=env is allowed.
 * - Base Sepolia public testnet: KMS_PROVIDER=env is allowed for practical testing.
 * - Base Mainnet and any non-Sepolia production chain: aws or vault is required.
 */

const crypto = require("crypto");
const { promisify } = require("util");
const logger = require("../utils/logger");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const hkdfAsync = promisify(crypto.hkdf);
let _masterKeyCache = null;

function _normalizeWalletAddress(walletAddress) {
  if (typeof walletAddress !== "string") throw new Error("walletAddress must be a string");
  const normalized = walletAddress.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new Error("Invalid walletAddress format");
  return normalized;
}

async function _getMasterKey() {
  if (_masterKeyCache) return _masterKeyCache;

  const provider = (process.env.KMS_PROVIDER || "env").toLowerCase();

  if (provider === "env") {
    const chainId = Number(process.env.CHAIN_ID || 0);
    const isBaseSepolia = chainId === 84532;

    if (process.env.NODE_ENV === "production" && !isBaseSepolia) {
      throw new Error(
        "SEC-01 BLOCKER: KMS_PROVIDER='env' yalnız Base Sepolia public testnet için kullanılabilir. " +
        "Base Mainnet'te AWS KMS veya HashiCorp Vault kullanın."
      );
    }

    const hex = process.env.MASTER_ENCRYPTION_KEY;
    if (!hex || hex.length < 64) {
      throw new Error("MASTER_ENCRYPTION_KEY is missing or too short (need 32 bytes / 64 hex chars)");
    }

    _masterKeyCache = Buffer.from(hex.slice(0, 64), "hex");
    if (process.env.NODE_ENV === "production") {
      logger.warn("[Encryption] Master key env'den okunuyor - yalnız Base Sepolia public testnet için kabul edildi.");
    } else {
      logger.warn("[Encryption] Master key env'den okunuyor - development/testnet kullanımı.");
    }
    return _masterKeyCache;
  }

  if (provider === "aws") {
    try {
      const { KMSClient, DecryptCommand } = require("@aws-sdk/client-kms");
      const region = process.env.AWS_REGION || "eu-west-1";
      const encryptedKey = process.env.AWS_ENCRYPTED_DATA_KEY;
      if (!encryptedKey) throw new Error("AWS_ENCRYPTED_DATA_KEY tanımlı değil");

      const kms = new KMSClient({ region });
      const command = new DecryptCommand({ CiphertextBlob: Buffer.from(encryptedKey, "base64") });
      const response = await kms.send(command);
      _masterKeyCache = Buffer.from(response.Plaintext);
      logger.info("[Encryption] Master key AWS KMS'ten çözüldü.");
      return _masterKeyCache;
    } catch (err) {
      throw new Error(`AWS KMS master key çözme hatası: ${err.message}`);
    }
  }

  if (provider === "vault") {
    try {
      const vaultAddr = process.env.VAULT_ADDR;
      const vaultToken = process.env.VAULT_TOKEN;
      const keyName = process.env.VAULT_KEY_NAME || "araf-master-key";
      if (!vaultAddr || !vaultToken) throw new Error("VAULT_ADDR ve VAULT_TOKEN tanımlı olmalı");

      const url = `${vaultAddr}/v1/transit/datakey/plaintext/${keyName}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "X-Vault-Token": vaultToken, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) throw new Error(`Vault HTTP ${response.status}: ${await response.text()}`);
      const data = await response.json();
      _masterKeyCache = Buffer.from(data.data.plaintext, "base64").slice(0, KEY_LENGTH);
      logger.info("[Encryption] Master key Vault'tan alındı.");
      return _masterKeyCache;
    } catch (err) {
      throw new Error(`Vault master key alma hatası: ${err.message}`);
    }
  }

  throw new Error(`Bilinmeyen KMS_PROVIDER: ${provider}. Geçerli değerler: env, aws, vault`);
}

async function _deriveDataKey(walletAddress) {
  const masterKey = await _getMasterKey();
  const normalizedWallet = _normalizeWalletAddress(walletAddress);
  const salt = crypto.createHash("sha256").update(`araf-pii-salt-v1:${normalizedWallet}`).digest();
  const info = Buffer.from("araf-pii-dek-v1");
  const dek = await hkdfAsync("sha256", masterKey, salt, info, KEY_LENGTH);
  return Buffer.from(dek);
}

async function _withDataKey(walletAddress, operation) {
  const dek = await _deriveDataKey(walletAddress);
  try {
    return await operation(dek);
  } finally {
    dek.fill(0);
  }
}

async function encryptField(plaintext, walletAddress) {
  const normalizedWallet = _normalizeWalletAddress(walletAddress);
  return _withDataKey(normalizedWallet, async (dek) => {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("hex");
  });
}

async function decryptField(cipherHex, walletAddress) {
  const normalizedWallet = _normalizeWalletAddress(walletAddress);
  return _withDataKey(normalizedWallet, async (dek) => {
    const data = Buffer.from(cipherHex, "hex");
    if (data.length < IV_LENGTH + TAG_LENGTH + 1) throw new Error("Invalid ciphertext format");
    const iv = data.slice(0, IV_LENGTH);
    const tag = data.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = data.slice(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, dek, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final("utf8");
  });
}

async function encryptPII(rawPII, walletAddress) {
  const addr = _normalizeWalletAddress(walletAddress);
  return {
    bankOwner_enc: rawPII.bankOwner ? await encryptField(rawPII.bankOwner, addr) : null,
    iban_enc: rawPII.iban ? await encryptField(rawPII.iban, addr) : null,
    telegram_enc: rawPII.telegram ? await encryptField(rawPII.telegram, addr) : null,
  };
}

async function decryptPII(encPII, walletAddress) {
  const addr = _normalizeWalletAddress(walletAddress);
  return {
    bankOwner: encPII.bankOwner_enc ? await decryptField(encPII.bankOwner_enc, addr) : null,
    iban: encPII.iban_enc ? await decryptField(encPII.iban_enc, addr) : null,
    telegram: encPII.telegram_enc ? await decryptField(encPII.telegram_enc, addr) : null,
  };
}

function clearMasterKeyCache() {
  if (_masterKeyCache) {
    _masterKeyCache.fill(0);
    _masterKeyCache = null;
    logger.info("[Encryption] Master key cache temizlendi.");
  }
}

module.exports = { encryptPII, decryptPII, encryptField, decryptField, clearMasterKeyCache };
