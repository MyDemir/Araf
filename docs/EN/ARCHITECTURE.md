# 🌀 Araf Protocol — Canonical Architecture & Technical Reference

> **Version:** 2.0 | **Network:** Base (Layer 2) | **Status:** Tesnet Ready | **Last Updated:** March 2026

---

## Table of Contents

1. [Vision and Core Philosophy](#1-vision-and-core-philosophy)
2. [Hybrid Architecture: On-Chain vs. Off-Chain](#2-hybrid-architecture-on-chain-vs-off-chain)
3. [System Participants](#3-system-participants)
4. [Tier and Collateral System](#4-tier-and-collateral-system)
5. [Anti-Sybil Shield](#5-anti-sybil-shield)
6. [Standard Transaction Flow (Happy Path)](#6-standard-transaction-flow-happy-path)
7. [Dispute System — Bleeding Escrow](#7-dispute-system--bleeding-escrow)
8. [Reputation and Penalty System](#8-reputation-and-penalty-system)
9. [Security Architecture](#9-security-architecture)
10. [Data Models (MongoDB)](#10-data-models-mongodb)
11. [Treasury Model](#11-treasury-model)
12. [Attack Vectors and Known Limitations](#12-attack-vectors-and-known-limitations)
13. [Finalized Protocol Parameters](#13-finalized-protocol-parameters)
14. [Future Evolution Path](#14-future-evolution-path)

---

## 1. Vision and Core Philosophy

Araf Protocol is a **non-custodial, humanless, and oracle-free** peer-to-peer escrow system that enables swaps between fiat currency (TRY / USD / EUR) and crypto assets (USDT / USDC) in a trustless environment. No moderators, no appeals to an arbitrator, no customer service. Disputes are resolved autonomously by on-chain timers and economic game theory.

> *"The system doesn't judge. It makes dishonesty expensive."*

### Core Principles

| Principle | Description |
|---|---|
| **Non-Custodial** | The platform never touches user funds. All assets are locked in a transparent smart contract. |
| **Oracle-Free Dispute Resolution** | No external data source determines the winner in disputes. The resolution is purely time-based (Bleeding Escrow). |
| **Humanless** | No moderators. No juries. The code and timers decide everything. |
| **MAD-Based Security** | Mutually Assured Destruction (MAD) game theory: dishonest behavior always costs more than honest behavior. |
| **Zero Private Key Backend** | The backend server holds no wallet keys and cannot move funds. |

### Oracle-Independence Explained

**Areas where Oracles are NOT used:**
- ❌ Verification of bank transfers
- ❌ Deciding the "rightful party" in disputes
- ❌ Any external data feed triggering escrow release

**Data living off-chain (and why):**
- ✅ PII data (IBAN, Telegram) — **GDPR / KVKK: Right to be Forgotten**
- ✅ Order book and listings — **Performance: Sub-50ms queries**
- ✅ Analytics — **User experience: real-time statistics**

> The importance of the distinction: Oracles are only used for legal data storage — **never for dispute outcomes.**

---

## 2. Hybrid Architecture: On-Chain vs. Off-Chain

Araf operates as a **Web2.5 Hybrid System**. Security-critical operations live on-chain; privacy and performance-critical data live off-chain.

### Architectural Decision Matrix

| Component | Storage | Technology | Rationale |
|---|---|---|---|
| USDT / USDC Escrow | On-Chain | ArafEscrow.sol | Immutable, non-custodial, trustless |
| Transaction State Machine | On-Chain | ArafEscrow.sol | Bleeding timer is fully autonomous |
| Reputation Scores | On-Chain | ArafEscrow.sol | Permanent, unforgeable proof of history |
| Collateral Calculations | On-Chain | ArafEscrow.sol | No backend can manipulate penalties |
| Anti-Sybil Checks | On-Chain | ArafEscrow.sol | Wallet age, dust, cooldown are enforced |
| PII Data (IBAN / Name) | Off-Chain | MongoDB + KMS | GDPR / KVKK: Right to be Forgotten |
| Order Book & Listings | Off-Chain | MongoDB | Sub-50ms queries, free filtering |
| Event Cache | Off-Chain | MongoDB | Transaction state mirror for a fast UI |
| Rate Limiting / Nonces | In-Memory | Redis | 5-min TTL, sliding window, replay protection |

### Technology Stack

| Layer | Technology | Details |
|---|---|---|
| Smart Contract | Solidity + Hardhat | 0.8.24 — Base L2 (Chain ID 8453) |
| Backend | Node.js + Express | CommonJS, Zero Private Key Relayer |
| Database | MongoDB + Mongoose | v8.x — Listings, Trades, Users |
| Cache / Auth | Redis | v4.x — Rate limits, Nonces, DLQ |
| Encryption | AES-256-GCM + HKDF | Envelope encryption, per-wallet DEK |
| Authentication | SIWE + JWT (HS256) | EIP-4361, 15-minute validity |
| Frontend | React 18 + Vite + Wagmi | Tailwind CSS, viem, EIP-712 |
| Contract ABI | Auto-generated on deploy | `frontend/src/abi/ArafEscrow.json` |

### Zero-Trust Backend Model

Despite using an off-chain infrastructure, **the backend cannot steal funds or manipulate outcomes:**

```
✅ Backend has ZERO private keys (Relayer pattern)
✅ Backend cannot release escrow (only users can sign)
✅ Backend cannot bypass the Bleeding Escrow timer (enforced on-chain)
✅ Backend cannot fake reputation scores (verified on-chain)
⚠️  Backend can decrypt PII (necessary evil for UX — mitigated by rate limiting + audit logs)
```

---

## 3. System Participants

| Role | Label | Abilities | Constraints |
|---|---|---|---|
| **Maker** | Seller | Creates listings. Locks USDT + Collateral. Can release, challenge, propose cancel. | Cannot be a Taker in their own listing. Collateral is locked until the trade is resolved. |
| **Taker** | Buyer | Sends fiat off-chain. Locks Taker Collateral. Can report payment, approve cancel. | Subject to Anti-Sybil filters. Can be banned (Taker-only restriction). |
| **Treasury** | Protocol | Receives a 0.2% success fee + decayed/burned funds. | Address is set at deploy time — cannot be changed by the backend. |
| **Backend** | Relayer | Stores encrypted PII, indexes the order book, issues JWTs, serves the API. | Zero private keys. Cannot move funds. Cannot change on-chain state. |

---

## 4. Tier and Collateral System

The 5-tier system solves the **"Cold Start" problem**: new wallets cannot immediately access high-volume trades, thus protecting experienced users from untested counterparties. All collateral constants are enforced on-chain and cannot be changed by the backend.

### Tier Definitions

> **NEW RULE:** A user can only create or take listings that are at or below their current effective tier level.

| Tier | Crypto Limit (USDT/USDC) | Maker Collateral | Taker Collateral | Cooldown | **Required Reputation for Access (On-Chain Enforced)** |
|---|---|---|---|---|---|
| **Tier 0** | Maximum 150 USDT | 0% | 0% | 4 hours / trade | **Default:** All new users start here. |
| **Tier 1** | Maximum 1,500 USDT | 8% | 10% | 4 hours / trade | ≥ 15 successful trades, 15 days active, **≤ 2 failed disputes** |
| **Tier 2** | Maximum 7,500 USDT | 6% | 8% | Unlimited | ≥ 50 successful trades, **≤ 5 failed disputes** |
| **Tier 3** | Maximum 30,000 USDT | 5% | 5% | Unlimited | ≥ 100 successful trades, **≤ 10 failed disputes** |
| **Tier 4** | Unlimited (30,000+ USDT) | 2% | 2% | Unlimited | ≥ 200 successful trades, **≤ 15 failed disputes** |

Note: To prevent Rate Manipulation, limits are calculated entirely based on Crypto assets (USDT/USDC). Fiat (TRY/USD) exchange rates are not considered when determining limits.

### Effective Tier Calculation

The maximum tier a user can trade at is determined by taking the **lower** of two values:
1.  **Reputation-Based Tier:** The highest tier the user has reached based on their `successfulTrades` and `failedDisputes` counts, according to the table above.
2.  **Penalty-Based Tier Ceiling (`maxAllowedTier`):** The tier demotion penalty applied as a result of consecutive bans.

Example: Even if a user has enough reputation for Tier 3, if their `maxAllowedTier` has been reduced to 1 due to a penalty, they can only participate in Tier 0 and Tier 1 trades.

### Reputation-Based Collateral Modifiers

Applied on top of the base collateral rates for Tiers 1–4 (not applied to Tier 0):

| Condition | Effect |
|---|---|
| 0 failed disputes + at least 1 successful trade | −1% collateral discount (clean history reward) |
| 1 or more failed disputes | +3% collateral penalty |

---

## 5. Anti-Sybil Shield

Four on-chain filters run before every `lockEscrow()` call. The backend **cannot bypass or override** them.

| Filter | Rule | Purpose |
|---|---|---|
| **Self-Trade Prevention** | `msg.sender ≠ maker address` | Prevents fake trading in one's own listings |
| **Wallet Age** | Registration ≥ 7 days before the first trade | Deters newly created Sybil wallets |
| **Dust Limit** | Native balance ≥ 0.001 ETH (~$2 on Base) | Deters disposable wallets with zero balance |
| **Tier 0 / 1 Cooldown** | Max 1 trade per 24 hours | Limits bot-scaled spam attacks in low-collateral tiers |
| **Challenge Ping Cooldown** | Must wait ≥ 24 hours after `PAID` state for `pingTakerForChallenge` | Prevents erroneous disputes and instant harassment |

### Related Contract Functions

| Function | Description |
|---|---|
| `registerWallet()` | Allows a wallet to start the 7-day "wallet aging" process. Mandatory for the Anti-Sybil check in the `lockEscrow` function. |
| `antiSybilCheck(address)` | A `view` function that checks if a wallet passes the Anti-Sybil controls (wallet age, balance, cooldown). |

---

## 6. Standard Transaction Flow (Happy Path)

```
Maker calls createEscrow()
  → OPEN (USDT + Maker Collateral locked on-chain)
    → Taker lockEscrow() — Anti-Sybil passes
      → LOCKED (Taker Collateral locked on-chain)
        → Taker reportPayment() + IPFS receipt hash
          → PAID (48-hour Grace Period timer starts on-chain)
            → Maker calls releaseFunds()
              → RESOLVED ✅ (0.2% fee deducted, funds distributed)
```

### State Definitions

| State | Trigger | Description |
|---|---|---|
| `OPEN` | Maker `createEscrow()` | Listing is live. USDT + Maker collateral locked on-chain. |
| `LOCKED` | Taker `lockEscrow()` | Anti-Sybil passed. Taker collateral locked on-chain. |
| `PAID` | Taker `reportPayment()` | IPFS receipt hash saved on-chain. 48-hour timer started. |
| `RESOLVED` | Maker `releaseFunds()` | 0.2% fee taken. USDT → Taker. Collaterals returned. |
| `CANCELED` | 2/2 EIP-712 signature | **LOCKED state:** Zero fees, full refund to both parties. **PAID or CHALLENGED state:** Standard protocol fee (0.2%) deducted from remaining amounts; net refund returned to both parties. No reputation penalty in either case. |
| `BURNED` | `burnExpired()` after 240 hours | All remaining funds → Treasury. |

### Fee Model

- **Taker fee:** 0.1% deducted from the USDT the Taker receives
- **Maker fee:** 0.1% deducted from the Maker's collateral return
- **Total:** 0.2% on every successfully resolved trade
- **Canceled trades:** No fees are taken

### Related Contract Functions

| Function | Description |
|---|---|
| `createEscrow(...)` | Allows the Maker to create a listing and lock funds. |
| `lockEscrow(tradeId)` | Allows the Taker to enter a listing and lock their collateral. |
| `reportPayment(tradeId, ipfsHash)` | Allows the Taker to report that the payment has been made. |
| `releaseFunds(tradeId)` | Allows the Maker to confirm payment and release the funds. |
| `cancelOpenEscrow(tradeId)` | Allows only the Maker to cancel a listing that has not yet been locked by a Taker (`OPEN` state) and get all their locked funds back. |
| `getTrade(tradeId)` | A `view` function that returns all details (`Trade` struct) of the specified `tradeId`. |

---

## 7. Dispute System — Bleeding Escrow

There is no arbitrator in the Araf Protocol. Instead, an **asymmetric time-decay mechanism** is used to make prolonged disputes mathematically expensive. The longer a party refuses to cooperate, the more they lose.

### Full State Machine

```
PAID
  │
  ├──[Maker presses Release]──────────────── RESOLVED ✅
  ├──[48h passes, Taker presses 'pingMaker'] → [24h more passes, Taker presses 'autoRelease']
  │   └── RESOLVED ✅ (Maker gets +1 Failed reputation, 5% penalty from both collaterals)
  │
  └──[Maker presses 'pingTakerForChallenge'] → [24h more passes, Maker presses 'challengeTrade']
      │
    DISPUTE OPENED
        GRACE PERIOD (48 hours) — no financial penalty
        ├──[Mutual Cancel (2/2 EIP-712)]────────── CANCELED 🔄
        ├──[Mutual Release]────────────────────── RESOLVED ✅
        │
        └──[No agreement after 48 hours]
                    │
                BLEEDING ⏳ (autonomous on-chain decay)
                ├── Taker collateral: 42 BPS/hour
                ├── Maker collateral: 26 BPS/hour
                ├── USDT (both parties): 34 BPS/hour (starts at 96th hour of Bleeding)
                │
                ├──[Release at any time]── RESOLVED ✅ (remaining funds)
                ├──[Cancel (2/2)]───────── CANCELED 🔄 (remaining funds)
                └──[240 hours pass — no agreement]
                          │
                        BURNED 💀 (all funds → Treasury)
```

### Bleeding Decay Rates

| Asset | Party | Rate | Start |
|---|---|---|---|
| **Taker Collateral** | Taker (dispute opener) | 42 BPS / hour (~10.1% per day) | 0th hour of Bleeding |
| **Maker Collateral** | Maker | 26 BPS / hour (~6.2% per day) | 0th hour of Bleeding |
| **USDT** | Both parties equally | 34 BPS / hour (~8.2% per day) | 96th hour of Bleeding |

> **Why does USDT start decaying at the 96th hour of Bleeding (144th hour in dispute)?**
> 48-hour grace period + a 96-hour buffer for weekend bank delays. It protects honest parties from immediate harm while maintaining urgency.

### Mutual Cancel (EIP-712)

Both parties can propose a mutual exit in `LOCKED`, `PAID`, or `CHALLENGED` states. Both must sign an EIP-712 typed message off-chain. After the signatures are collected by the backend, one of the parties sends them on-chain. Full refund, no fees, no reputation penalty.

Signature type: `CancelProposal(uint256 tradeId, address proposer, uint256 nonce, uint256 deadline)`

### `autoRelease` and Negligence Penalty

If the Taker receives no response 24 hours after calling the `pingMaker` function, they can call `autoRelease` to unilaterally release the funds. In this case, instead of the standard transaction fee, a **2% negligence penalty** (`AUTO_RELEASE_PENALTY_BPS`) is deducted from both the Maker's and the Taker's collateral and transferred to the Treasury. This mechanism ensures that the Taker also has a small cost for forcibly ending the process, balancing the system and deterring abuse against the Maker.

### Related Contract Functions

| Function | Description |
|---|---|
| `pingTakerForChallenge(tradeId)` | Allows the Maker to send a "payment not received" warning to the Taker before challenging. It is a mandatory prerequisite for `challengeTrade`. |
| `challengeTrade(tradeId)` | Allows the Maker to initiate the "Bleeding Escrow" phase by disputing a trade 24 hours after `pingTakerForChallenge`. |
| `pingMaker(tradeId)` | Allows the Taker to send a "liveness signal" to a passive Maker after the 48-hour `GRACE_PERIOD` has expired. This is a prerequisite for calling `autoRelease`. **Note:** To prevent ConflictingPingPath errors, if the Maker has already pinged the Taker (`pingTakerForChallenge`), this function cannot be used. |
| `autoRelease(tradeId)` | Allows the Taker to unilaterally release funds against a Maker who has not responded for 24 hours after being pinged. |
| `proposeOrApproveCancel(...)` | Allows parties to propose or approve a mutual cancellation with an EIP-712 signature. |
| `burnExpired(tradeId)` | Allows for all funds in a trade that has exceeded the 10-day bleeding period to be transferred to the Treasury. Valid only for trades in the `CHALLENGED` (Purgatory) state. |
| `getCurrentAmounts(tradeId)` | A `view` function that calculates and returns the current amounts of crypto and collateral remaining after the "Bleeding Escrow" mechanism in a dispute. |

---

## 8. Reputation and Penalty System

### Reputation Update Logic

| Outcome | Maker | Taker |
|---|---|---|
| Close without dispute (RESOLVED) | +1 Successful | +1 Successful |
| Maker disputed → then released (S2) | +1 Failed | +1 Successful |
| `autoRelease` — Maker was passive for 48h | +1 Failed | +1 Successful |
| BURNED (10-day timeout) | +1 Failed | +1 Failed |

### Ban and Consecutive Escalation

**Trigger:** 2 or more `failedDisputes`. The ban is applied **only to the Taker** — banned wallets can still create listings as a Maker.

| Ban Count | Duration | Tier Effect | Notes |
|---|---|---|---|
| 1st ban | 30 days | No tier change | `consecutiveBans = 1` |
| 2nd ban | 60 days | `maxAllowedTier −1` | `consecutiveBans = 2` |
| 3rd ban | 120 days | `maxAllowedTier −1` | `consecutiveBans = 3` |
| Nth ban | 30 × 2^(N−1) days (max 365) | `maxAllowedTier −1` at each ban (floor: Tier 0) | Permanent on-chain memory |

> **Tier Ceiling Enforcement:** `createEscrow()` reverts if the requested tier > `maxAllowedTier`.
> Example: A Tier 3 wallet gets its 2nd ban → `maxAllowedTier` drops to 2. They cannot create Tier 3 or Tier 4 listings.

### Related Contract Functions

| Function | Description |
|---|---|
| `getReputation(address)` | A `view` function that returns all reputation data for a wallet (successful/failed trades, ban status, effective tier). |
| `decayReputation(address)` | Implements the "Clean Slate" rule on-chain. If more than 180 days have passed since a user's last ban expired, it resets their `consecutiveBans` counter. **Note:** Users can trigger this directly by paying their own gas via the Profile Center UI. **Important Note:** To prevent abuse, this function does not reset the `maxAllowedTier` (Tier Ceiling) penalty. The user must earn back their lost Tier levels by contributing honestly to the system again. |

---

## 9. Security Architecture

### 9.1 Authentication Flow (SIWE + JWT)

| Step | Actor | Action | Security Feature |
|---|---|---|---|
| 1 | Frontend | `GET /api/auth/nonce` | Nonce is stored in Redis with a 5-minute TTL |
| 2 | User | Signs EIP-4361 SIWE message in wallet | Standard format via `siwe.SiweMessage` class |
| 3 | Frontend | `POST /api/auth/verify` — message + signature | Nonce is atomically consumed (`getDel` — replay protection) |
| 4 | Backend | Verifies SIWE signature, issues JWT (HS256, 15 min) | JWT has a `type: "auth"` claim, contains no PII |
| 5 | Frontend | Uses JWT as Bearer token for all protected API calls | Each route calls `requireAuth` middleware |

### 9.2 Mutual Cancel Flow (Gasless Agreement with EIP-712)

The protocol uses the **EIP-712** standard to allow parties to reach an agreement without an on-chain transaction (and without paying gas). This plays a critical role, especially in the "Mutual Cancel" scenario.

**What is EIP-712?** It allows users to sign human-readable, structured data in their wallets instead of meaningless hexadecimal strings. This is a major step forward in terms of security and user experience.

**Step-by-Step Flow:**

1.  **Proposal (Frontend):** A user (e.g., Maker) clicks the "Propose Cancel" button.
2.  **Data Structuring (Frontend):** The interface populates the `CancelProposal(uint256 tradeId, address proposer, uint256 nonce, uint256 deadline)` structure with on-chain data.
3.  **Signing (User Wallet):** The user sees a signature request in their wallet (e.g., MetaMask) containing this structured data and approves it.
4.  **Submission (Backend):** The frontend sends this signature and proposal data to the `POST /api/trades/propose-cancel` endpoint.
5.  **Storage (Backend):** The backend temporarily stores the Maker's signature in the `Trades` collection.
6.  **Approval (Other Party):** The Taker sees this cancellation proposal in the interface. When they click "Approve," they repeat steps 1-4 for themselves.
7.  **Consolidation (Backend):** The backend now has valid signatures from both parties.
8.  **On-Chain Execution (Frontend):** Either party (or a relayer) can take both signatures and call the `proposeOrApproveCancel()` function on the `ArafEscrow.sol` contract.
9.  **Verification (Smart Contract):** The `proposeOrApproveCancel()` function verifies both signatures, checks the deadline, increments the nonces to prevent replay, and if everything is valid, executes the cancellation.

### 9.3 PII Encryption (Envelope Encryption)

IBAN and bank owner names are only stored encrypted in MongoDB using AES-256-GCM. The Master Key never leaves the KMS environment. Each wallet gets a unique Data Encryption Key (DEK) derived deterministically with HKDF (RFC 5869, SHA-256).

| Feature | Value |
|---|---|
| Algorithm | AES-256-GCM (authenticated encryption) |
| Key Derivation | HKDF (SHA-256, RFC 5869) — native Node.js crypto |
| DEK Scope | Unique DEK per wallet — never reused |
| Master Key Storage | Environment variable (dev) / AWS KMS or Vault (prod) |
| Raw IP Storage | Never stored. Only SHA-256(IP) hash — GDPR compliant |
| IBAN Access Flow | Auth JWT → PII token (15 min, trade-scoped) → decryption |

### 9.4 Rate Limiting

| Endpoint Group | Limit | Window | Key |
|---|---|---|---|
| PII / IBAN | 3 requests | 10 minutes | IP + Wallet |
| Auth (SIWE) | 10 requests | 1 minute | IP |
| Listings (read) | 100 requests | 1 minute | IP |
| Listings (write) | 5 requests | 1 hour | Wallet |
| Trades | 30 requests | 1 minute | Wallet |
| Feedback | 3 requests | 1 hour | Wallet |

### 9.5 Event Listener Reliability

- **Checkpoint:** The last processed block number is saved to Redis after each batch.
- **Replay:** On restart, missed blocks are scanned from the checkpoint.
- **Retry:** Failed events are retried 3 times with exponential backoff.
- **Dead Letter Queue (DLQ):** Events that fail all retries are written to a Redis DLQ.
- **DLQ Monitor:** Runs every 60 seconds — alerts if DLQ has ≥ 5 entries.
- **Reconnect:** Automatically reconnects on RPC provider failure.

### 9.6 Encrypted Receipt Storage and Right to be Forgotten (TTL)

When a Taker uploads a receipt, instead of dropping it onto the public IPFS, it is encrypted on the backend via AES-256-GCM and stored in the database/temporary storage. The SHA-256 hash of the file is returned to the frontend and saved to the smart contract. Once the trade moves to the `RESOLVED` or `CANCELED` status, the receipt data is deleted within a maximum of 24 hours. For `CHALLENGED` or `BURNED` trades, it is permanently deleted 30 days after the process concludes.

### 9.7 Triangulation Fraud Prevention

To prevent triangulation fraud; when the trade enters the `LOCKED` state, the Maker (Seller) is shown the "Full Name" of the Taker (Buyer), decrypted from the Backend on the Trade Room screen. The Maker is warned to confirm that the sender name on the incoming funds EXACTLY matches this name. In case of a mismatch, they are directed to cancel the trade.

### 9.8 On-Chain Security Functions

| Function | Description |
|---|---|
| `pause()` / `unpause()` | Functions that can only be called by the contract owner (`Owner`) to temporarily halt new trade creation and locking in case of an emergency. |
| `domainSeparator()` | Returns the contract-specific domain separator required for EIP-712 signatures. Used by the frontend when creating signatures. |
| `nonReentrant` (Modifier) | Prevents "re-entrancy" attacks by blocking a function from being called again while it is still executing. |

---

## 10. Data Models (MongoDB)

### Users Collection

| Field | Type | Description |
|---|---|---|
| `wallet_address` | String (unique) | Lowercase Ethereum address — primary identifier |
| `pii_data.bankOwner_enc` | String | AES-256-GCM encrypted bank owner name |
| `pii_data.iban_enc` | String | AES-256-GCM encrypted IBAN (TR format) |
| `pii_data.telegram_enc` | String | AES-256-GCM encrypted Telegram username |
| `reputation_cache.total_trades` | Number | Total number of successfully completed trades. |
| `reputation_cache.failed_disputes` | Number | Total number of failed disputes. |
| `reputation_cache.success_rate` | Number | Success rate calculated by `(total - failed) / total * 100`. |
| `reputation_cache.failure_score` | Number | Weighted failure score. Serious events like `BURNED` have a higher score. |
| `reputation_history` | Array | Historical record kept for the decay of failures over time. `[{ type: 'burned', score: 50, date: '...', tradeId: 123 }]` |
| `is_banned` / `banned_until` | Boolean / Date | Mirror of the on-chain ban status |
| `consecutive_bans` | Number (default: 0) | Mirror of the on-chain consecutive ban count |
| `max_allowed_tier` | Number (default: 4) | Mirror of the on-chain tier ceiling — for display only |
| `last_login` | Date | TTL: Automatic deletion after 2 years of inactivity (GDPR) |

### Listings Collection

| Field | Type | Description |
|---|---|---|
| `maker_address` | String | Address of the listing creator |
| `crypto_asset` | `USDT` \| `USDC` | The asset being sold |
| `fiat_currency` | `TRY` \| `USD` \| `EUR` | The requested fiat currency |
| `exchange_rate` | Number | Rate per 1 crypto unit |
| `limits.min` / `limits.max` | Number | Fiat amount range per trade |
| `tier_rules.required_tier` | 0 – 4 | Minimum tier required to take this listing |
| `tier_rules.maker_bond_pct` | Number | Maker collateral percentage |
| `tier_rules.taker_bond_pct` | Number | Taker collateral percentage |
| `status` | `OPEN` \| `PAUSED` \| `COMPLETED` \| `DELETED` | Listing lifecycle status |
| `onchain_escrow_id` | Number \| null | On-chain `tradeId` when the escrow is created |
| `token_address` | String | ERC-20 contract address on Base |

### Trades Collection

| Field Group | Key Fields | Notes |
|---|---|---|
| Identity | `onchain_escrow_id`, `listing_id`, `maker_address`, `taker_address` | `onchain_escrow_id` = source of truth |
| Financials | `crypto_amount`, `exchange_rate`, `total_decayed` | `total_decayed` = cumulative sum of `BleedingDecayed` events |
| Status | `status` | Mirrors the on-chain state machine |
| Timers | `locked_at`, `paid_at`, `challenged_at`, `resolved_at`, `last_decay_at` | `last_decay_at` = last `BleedingDecayed` event |
| Proof | `ipfs_receipt_hash`, `receipt_timestamp` | IPFS hash of the payment receipt |
| Cancel Proposal | `proposed_by`, `maker_signed`, `taker_signed`, signatures | EIP-712 signatures collected before on-chain submission |
| Chargeback Ack | `acknowledged`, `acknowledged_by`, `acknowledged_at`, `ip_hash` | Maker's legal acknowledgment before `releaseFunds`. `ip_hash = SHA-256(IP)` |
| Tier | `tier` (0–4) | On-chain tier at the time of trade creation |

---

## 11. Treasury Model

| Revenue Source | Rate | Condition |
|---|---|---|
| Success fee | 0.2% (0.1% from each party) | Every `RESOLVED` trade |
| Taker collateral decay | 42 BPS / hour | `CHALLENGED` + Bleeding phase |
| Maker collateral decay | 26 BPS / hour | `CHALLENGED` + Bleeding phase |
| USDT decay | 34 BPS / hour × 2 parties | After the 96th hour of Bleeding |
| BURNED result | 100% of remaining funds | No resolution within 240 hours |

### Related Contract Functions

| Function | Description |
|---|---|
| `setTreasury(address)` | A function that can only be called by the contract owner (`Owner`) to update the Treasury address where protocol fees and burned funds are sent. |

---

## 12. Attack Vectors and Known Limitations

| Attack | Risk | Mitigation | Status |
|---|---|---|---|
| Fake receipt upload | High | Dispute collateral penalty — decay cost exceeds potential gain | ⚠️ Partial |
| Seller harassment | Medium | Asymmetric decay: the disputer (Taker) loses faster | ✅ Mitigated |
| Chargeback (TRY reversal) | Medium | Chargeback acknowledgment log + IP hash evidence chain | ⚠️ Partial |
| Sybil reputation farming | Low | Wallet age + dust limit + unique counterparty weighting | ✅ Mitigated |
| Challenge spam (Tier 0/1) | High | 24-hour cooldown + dust limit + wallet age | ✅ Mitigated |
| Self-trading | High | On-chain `msg.sender ≠ maker` | ✅ Mitigated |
| Unilateral cancel abuse | High | 2/2 EIP-712 — unilateral cancellation is impossible | ✅ Mitigated |
| Backend key theft | Critical | Zero private key architecture — relayer only | ✅ Mitigated |
| JWT hijacking | High | 15-minute validity + trade-scoped PII tokens | ✅ Mitigated |
| PII data leak | Critical | AES-256-GCM + HKDF + rate limit (3 / 10 min) | ✅ Mitigated |
| Rate Manipulation | Critical | The system does not use fiat limits. Tier restrictions are strictly based on absolute crypto amounts (USDT/USDC) via on-chain limits. | ✅ Mitigated |

---

## 13. Finalized Protocol Parameters

All the following values are deployed as Solidity `public constant` — **they cannot be changed by the backend.**

| Parameter | Value | Contract Constant |
|---|---|---|
| Network | Base (Chain ID 8453) | — |
| Protocol fee | 0.2% (0.1% from each party) | `TAKER_FEE_BPS = 10`, `MAKER_FEE_BPS = 10` |
| Grace period | 48 hours | `GRACE_PERIOD` |
| USDT decay start | 96 hours after Bleeding starts (144th hour in dispute) | `USDT_DECAY_START` |
| Maximum bleeding duration | 240 hours (10 days) → BURNED | `MAX_BLEEDING` |
| Taker collateral decay rate | 42 BPS / hour | `TAKER_BOND_DECAY_BPS_H` |
| Maker collateral decay rate | 26 BPS / hour | `MAKER_BOND_DECAY_BPS_H` |
| USDT decay rate | 34 BPS / hour × 2 | `CRYPTO_DECAY_BPS_H` |
| Minimum wallet age | 7 days | `WALLET_AGE_MIN` |
| Minimum active period | 15 days | `MIN_ACTIVE_PERIOD` |
| Tier 0 / 1 cooldown | 4 hours / trade | `TIER0_TRADE_COOLDOWN`, `TIER1_TRADE_COOLDOWN` |
| Challenge Ping Cooldown | 24 hours after `PAID` | Enforced in `pingTakerForChallenge` |
| Dust limit | 0.001 ETH (~$2 on Base) | `DUST_LIMIT` |
| Clean reputation discount | −1% | `GOOD_REP_DISCOUNT_BPS = 100` |
| Bad reputation penalty | +3% | `BAD_REP_PENALTY_BPS = 300` |
| Ban trigger | 2+ failed disputes | `_updateReputation()` |
| 1st ban duration | 30 days | Escalation: `30 × 2^(N−1)` days |
| Maximum ban duration | 365 days | Capped in the contract |

### Other Admin Functions

The following functions can only be called by the contract owner (`Owner`) and manage the core operation of the protocol.

| Function | Description |
|---|---|
| `setSupportedToken(address, bool)` | Adds or removes supported ERC20 tokens (e.g., USDT, USDC) for trading in the protocol. |
| `setTreasury(address)` | Updates the Treasury address where protocol fees and burned funds are sent. |

---

## 14. Future Evolution Path

The evolution of the Araf Protocol will proceed through four main phases, driven by technical maturity and ecosystem growth rather than a fixed calendar.

| Phase | Strategic Focus | Key Milestones & Features |
| :--- | :--- | :--- |
| **Phase 1** | **Security & Preparation** | • Professional Smart Contract Audit<br>• Base Sepolia Public Beta Launch<br>• Treasury migration to Gnosis Safe (3/5 Multisig)<br>• AWS KMS / HashiCorp Vault Implementation |
| **Phase 2** | **Mainnet & UX** | • Official Base Mainnet Deployment<br>• Base Smart Wallet (Passkey) Support<br>• Paymaster Integration (Gasless UX)<br>• PWA High-Performance Mobile Interface |
| **Phase 3** | **Expansion & Multi-Asset** | • Order Book Depth & The Graph Indexing<br>• Multi-Asset Swap (ETH, cbBTC, etc.)<br>• Staking & Reputation Incentives (Retroactive)<br>• Institutional API for Liquidity Providers |
| **Phase 4** | **Privacy & Global Vision** | • ZK-Proof Based IBAN Verification<br>• OP Superchain Cross-Chain Escrow<br>• Full Anonymity & Global Liquidity Layer |

---

### Why the Hybrid Model is Honest

**What we decentralize (the critical parts):**
- ✅ Fund custody — non-custodial smart contract
- ✅ Dispute resolution — time-based, no human decision
- ✅ Reputation integrity — immutable on-chain records
- ✅ Anti-Sybil enforcement — on-chain checks

**What we centralize (for privacy / performance):**
- ⚠️ PII storage — GDPR requires the ability to delete
- ⚠️ Order book indexing — sub-second queries for UX

**The backend NEVER controls:**
- ❌ Fund custody | ❌ Dispute outcomes | ❌ Reputation scores | ❌ Trade state transitions

---

*Araf Protocol — "The system doesn't judge. It makes dishonesty expensive."*
