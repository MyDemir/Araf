# Araf Protocol — Deployment Guide

> **Version:** 2.1  
> **Last Updated:** March 2026  
> This guide covers three environments: **Local Development** · **Public Testnet (Base Sepolia)** · **Mainnet (Base)**

---

## Table of Contents

1. [Local Development](#1-local-development)
2. [Common Local Issues (Troubleshooting)](#2-common-local-issues-troubleshooting)
3. [Public Testnet — Base Sepolia](#3-public-testnet--base-sepolia)
4. [Mainnet — Base](#4-mainnet--base)
5. [Environment Differences Summary](#5-environment-differences-summary)

---

## 1. Local Development

Local development is now **chain-first** and should be tested that way.

Important local rules:
- If you start a separate Hardhat node with `npx hardhat node`, deploy to **`localhost`**, not `hardhat`.
- `/health` is **liveness only**.
- `/ready` is the actual **readiness** endpoint.
- Local SIWE should use an explicit `SIWE_DOMAIN` + `SIWE_URI` pair.
- Listing creation is now authoritative through **`listing_ref`**:
  - backend creates `listing_ref`
  - frontend sends `createEscrow(..., listingRef)`
  - worker links `EscrowCreated(..., listingRef)` back to the listing

### Prerequisites
- Node.js `v18+`
- Docker Desktop (recommended for MongoDB and Redis)
- MetaMask

### Step 1 — Start MongoDB and Redis

```bash
docker run -d --name araf-mongo -p 27017:27017 mongo:latest
docker run -d --name araf-redis -p 6379:6379 redis:latest
```

To stop them later:

```bash
docker stop araf-mongo araf-redis
```

### Step 2 — Install Dependencies

```bash
cd contracts && npm install && cd ..
cd backend  && npm install && cd ..
cd frontend && npm install && cd ..
```

### Step 3 — Terminal 1: Start Hardhat Node

```bash
cd contracts
npx hardhat node
```

This prints 20 funded test wallets.

Recommended usage:
- `Account #0` → deployer
- `Account #1` → treasury
- `Account #2` → relayer

### Step 4 — Terminal 2: Deploy Contracts to `localhost`

Create `contracts/.env`:

```bash
cat > contracts/.env << 'EOF'
TREASURY_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
EOF
```

Deploy:

```bash
cd contracts
npx hardhat run scripts/deploy.js --network localhost
```

Note the deploy output values:

```text
VITE_ESCROW_ADDRESS=0x...
VITE_USDT_ADDRESS=0x...
VITE_USDC_ADDRESS=0x...
```

### Step 5 — Terminal 3: Backend Configuration

Create `backend/.env`:

```bash
cat > backend/.env << 'EOF'
PORT=4000
NODE_ENV=development

MONGODB_URI=mongodb://127.0.0.1:27017/araf_dev
REDIS_URL=redis://127.0.0.1:6379

# Generate a strong secret:
# node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=<GENERATE_A_REAL_64+_CHAR_SECRET>
JWT_EXPIRES_IN=15m
PII_TOKEN_EXPIRES_IN=15m

KMS_PROVIDER=env
# Generate 32 bytes hex:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MASTER_ENCRYPTION_KEY=<GENERATE_A_REAL_32_BYTE_HEX_KEY>

BASE_RPC_URL=http://127.0.0.1:8545
ARAF_ESCROW_ADDRESS=<DEPLOY_OUTPUT_ESCROW_ADDRESS>
CHAIN_ID=31337
TREASURY_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
RELAYER_PRIVATE_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

SIWE_DOMAIN=localhost:5173
SIWE_URI=http://localhost:5173
ALLOWED_ORIGINS=http://localhost:5173

# Optional for local clarity; recommended when you want deterministic replay boot:
WORKER_START_BLOCK=0
EOF
```

Start backend:

```bash
cd backend
npm run dev
```

### Step 6 — Terminal 4: Frontend Configuration

Create `frontend/.env.development`:

```bash
cat > frontend/.env.development << 'EOF'
VITE_API_URL=http://localhost:4000
VITE_ESCROW_ADDRESS=<DEPLOY_OUTPUT_ESCROW_ADDRESS>
VITE_USDT_ADDRESS=<DEPLOY_OUTPUT_USDT_ADDRESS>
VITE_USDC_ADDRESS=<DEPLOY_OUTPUT_USDC_ADDRESS>
EOF
```

Start frontend:

```bash
cd frontend
npm run dev
```

### Step 7 — Add Hardhat Local Network to MetaMask

| Field | Value |
|------|-------|
| Network Name | Hardhat Local |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency Symbol | ETH |

Import the Hardhat test keys into MetaMask.

### Step 8 — Run Contract Tests

```bash
cd contracts
npx hardhat test
npx hardhat coverage
```

### Step 9 — Local Full-Stack Smoke Test

Run this flow end to end:

1. Open frontend at `http://localhost:5173`
2. Confirm backend liveness:
   - `GET http://localhost:4000/health`
3. Confirm backend readiness:
   - `GET http://localhost:4000/ready`
4. Connect MetaMask on chain `31337`
5. Complete SIWE login
6. Mint test USDT/USDC from the UI
7. Create a maker listing
8. Confirm backend generated `listing_ref`
9. Confirm frontend calls `createEscrow(token, amount, tier, listingRef)`
10. Confirm worker links `EscrowCreated(..., listingRef)` to the correct listing
11. Start trade as taker
12. Upload receipt
13. Call `reportPayment`
14. Release funds as maker
15. Separately test:
   - cancel flow
   - challenge flow
   - bleeding flow
   - DLQ remains empty or only contains expected test entries

### Local Development Checklist

- [ ] `npx hardhat node` is running
- [ ] `npx hardhat test` passes
- [ ] `GET /health` returns liveness OK
- [ ] `GET /ready` returns readiness OK
- [ ] Frontend opens at `http://localhost:5173`
- [ ] MetaMask is on `chainId: 31337`
- [ ] SIWE login succeeds
- [ ] Mock faucet works
- [ ] `listing_ref` is generated on listing creation
- [ ] `createEscrow(..., listingRef)` succeeds
- [ ] Worker links `EscrowCreated(..., listingRef)` correctly
- [ ] Full trade lifecycle works: create → lock → pay → release
- [ ] Cancel flow works
- [ ] Challenge / bleeding flow works
- [ ] DLQ is clean or understood

---

## 2. Common Local Issues (Troubleshooting)

### ❌ Port Already in Use (`EADDRINUSE`)

If backend (`4000`) or frontend (`5173`) fails to start because the port is already in use:

```bash
# macOS / Linux
killall -9 node

# Windows PowerShell
taskkill /F /IM node.exe
```

Or free a single port:

```bash
# macOS / Linux
lsof -i :4000
kill -9 <PID>
```

### ❌ MetaMask Nonce / Stuck Pending Transaction

If you restart Hardhat node, the chain resets but MetaMask remembers prior local nonces.

Fix:
1. Open MetaMask
2. Go to **Settings**
3. Open **Advanced**
4. Click **Clear Activity Data**

### ❌ `/ready` fails while `/health` passes

This is expected if the app is alive but not actually ready.

Typical causes:
- MongoDB not connected
- Redis not connected
- worker not running
- bad `SIWE_DOMAIN` / `SIWE_URI`
- missing `ARAF_ESCROW_ADDRESS`
- missing `BASE_RPC_URL`

Use `/ready`, not `/health`, to judge whether local integration is truly bootstrapped.

### ❌ SIWE Login Fails Locally

Check these first:
- `SIWE_DOMAIN=localhost:5173`
- `SIWE_URI=http://localhost:5173`
- `ALLOWED_ORIGINS=http://localhost:5173`
- frontend actually loads from `http://localhost:5173`

If those differ, backend exact-origin SIWE checks will reject login.

### ❌ Listing Created but Worker Does Not Link It

Check:
- listing has a `listing_ref`
- frontend passed that `listing_ref` to `createEscrow`
- worker received `EscrowCreated(..., listingRef)`
- worker/provider is running and `/ready` is healthy

If `listing_ref` is missing or mismatched, the system should fail closed instead of heuristically assigning ownership.

### ❌ Codespaces Resource Pressure

If you run MongoDB, Redis, Hardhat, backend, and frontend together in a constrained Codespace, RAM pressure may freeze the session.

Mitigations:
1. Stop Docker containers temporarily if not needed:
   ```bash
   docker stop araf-mongo araf-redis
   ```
2. Prefer local machine execution for full-stack integration and dispute-flow testing.

### 🔎 Centralized Error Monitoring

Keep logs open while testing:

```bash
tail -f araf_full_stack.log.txt
```

---

## 3. Public Testnet — Base Sepolia

### Prerequisites
- Base Sepolia configured in MetaMask
- Base Sepolia ETH from a faucet
- Alchemy / Infura account
- MongoDB Atlas
- Upstash Redis
- Fly.io account
- Vercel account
- BaseScan API key

### Step 1 — Deploy Contracts

Create `contracts/.env`:

```bash
cat > contracts/.env << 'EOF'
DEPLOYER_PRIVATE_KEY=0x<TESTNET_DEPLOYER_PRIVATE_KEY>
TREASURY_ADDRESS=0x<TESTNET_TREASURY_WALLET>
BASE_SEPOLIA_RPC_URL=https://base-sepolia.g.alchemy.com/v2/<API_KEY>
BASESCAN_API_KEY=<BASESCAN_API_KEY>
REPORT_GAS=true
EOF
```

Deploy:

```bash
cd contracts
npx hardhat compile
npx hardhat run scripts/deploy.js --network base-sepolia
```

Expected output includes:
- `ArafEscrow` address
- `MockUSDT` address
- `MockUSDC` address
- ownership transfer confirmation

### Step 2 — Verify on BaseScan

```bash
cd contracts

npx hardhat verify --network base-sepolia <ARAF_ESCROW_ADDRESS> <TREASURY_ADDRESS>
npx hardhat verify --network base-sepolia <USDT_ADDRESS> "Mock USDT" "USDT" 6
npx hardhat verify --network base-sepolia <USDC_ADDRESS> "Mock USDC" "USDC" 6
```

### Step 3 — Deploy Backend to Fly.io

```bash
cd backend
fly apps create araf-protocol-backend

fly secrets set \
  NODE_ENV="production" \
  MONGODB_URI="mongodb+srv://<user>:<pass>@cluster.mongodb.net/araf_testnet" \
  REDIS_URL="rediss://:<token>@<host>.upstash.io:6379" \
  JWT_SECRET="<64+_CHAR_SECRET>" \
  JWT_EXPIRES_IN="15m" \
  PII_TOKEN_EXPIRES_IN="15m" \
  KMS_PROVIDER="env" \
  MASTER_ENCRYPTION_KEY="<32_BYTE_HEX>" \
  BASE_RPC_URL="https://base-sepolia.g.alchemy.com/v2/<API_KEY>" \
  BASE_WS_RPC_URL="wss://base-sepolia.g.alchemy.com/v2/<API_KEY>" \
  ARAF_ESCROW_ADDRESS="<DEPLOY_ADDRESS>" \
  CHAIN_ID="84532" \
  TREASURY_ADDRESS="<TREASURY_WALLET>" \
  RELAYER_PRIVATE_KEY="0x<RELAYER_PRIVATE_KEY>" \
  SIWE_DOMAIN="araf-protocol.vercel.app" \
  SIWE_URI="https://araf-protocol.vercel.app" \
  ALLOWED_ORIGINS="https://araf-protocol.vercel.app" \
  ARAF_DEPLOYMENT_BLOCK="<DEPLOY_BLOCK_NUMBER>"

fly deploy
fly logs --app araf-protocol-backend
```

If this is the first deploy and Redis has no checkpoint yet, seed it once:

```bash
redis-cli -u "$REDIS_URL" SET worker:last_block "$ARAF_DEPLOYMENT_BLOCK"
```

### Step 4 — Deploy Frontend to Vercel

Create `frontend/.env.production`:

```bash
cat > frontend/.env.production << 'EOF'
VITE_API_URL=https://araf-protocol-backend.fly.dev
VITE_ESCROW_ADDRESS=<DEPLOY_ADDRESS>
VITE_USDT_ADDRESS=<USDT_ADDRESS>
VITE_USDC_ADDRESS=<USDC_ADDRESS>
EOF
```

Deploy:

```bash
cd frontend
vercel --prod
```

### Step 5 — Testnet Checklist

- [ ] Contracts verified on BaseScan
- [ ] Backend `/health` responds
- [ ] Backend `/ready` responds OK
- [ ] Frontend opens successfully
- [ ] MetaMask is connected to Base Sepolia
- [ ] SIWE login succeeds
- [ ] Mock USDT/USDC faucet works
- [ ] Full lifecycle works: create → lock → pay → release
- [ ] Challenge / bleeding / cancel flows work
- [ ] `listing_ref` flow works end to end
- [ ] Fly logs are clean

---

## 4. Mainnet — Base

> **Mandatory before Mainnet:** complete a professional security audit and close findings.

### Testnet vs Mainnet Differences

| Field | Testnet | Mainnet |
|------|---------|---------|
| MockERC20 | Deployed | **Not deployed** (`NODE_ENV=production`) |
| KMS | `env` (temporary) | AWS KMS or HashiCorp Vault |
| Treasury | Test wallet | **Gnosis Safe multisig** |
| RPC | Sepolia RPC | Base Mainnet RPC |
| Chain ID | `84532` | `8453` |
| Relayer | Manual wallet | Gelato Automation recommended |
| Audit | Optional | **Mandatory** |

### Step 1 — Prepare Treasury

Use a Gnosis Safe on Base Mainnet.

Minimum recommendation:
- 3/5 multisig

Never use a single EOA treasury in production.

### Step 2 — Prepare Production Encryption

Recommended:
- AWS KMS
- or HashiCorp Vault

### Step 3 — Deploy Contracts

Create `contracts/.env`:

```bash
cat > contracts/.env << 'EOF'
DEPLOYER_PRIVATE_KEY=0x<MAINNET_DEPLOYER_PRIVATE_KEY>
TREASURY_ADDRESS=0x<GNOSIS_SAFE_ADDRESS>
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<API_KEY>
BASESCAN_API_KEY=<BASESCAN_API_KEY>
MAINNET_USDT_ADDRESS=0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
MAINNET_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
EOF
```

Deploy:

```bash
cd contracts
NODE_ENV=production npx hardhat run scripts/deploy.js --network base
npx hardhat verify --network base <ESCROW_ADDRESS> <GNOSIS_SAFE_ADDRESS>
```

### Step 4 — Production Backend Configuration

```bash
fly secrets set \
  NODE_ENV="production" \
  KMS_PROVIDER="aws" \
  AWS_KMS_KEY_ARN="arn:aws:kms:..." \
  AWS_ENCRYPTED_DATA_KEY="<BASE64_CIPHERTEXT_BLOB>" \
  AWS_REGION="eu-west-1" \
  BASE_RPC_URL="https://base-mainnet.g.alchemy.com/v2/<API_KEY>" \
  BASE_WS_RPC_URL="wss://base-mainnet.g.alchemy.com/v2/<API_KEY>" \
  CHAIN_ID="8453" \
  ARAF_ESCROW_ADDRESS="<MAINNET_ESCROW>" \
  TREASURY_ADDRESS="<GNOSIS_SAFE>" \
  SIWE_DOMAIN="app.araf.xyz" \
  SIWE_URI="https://app.araf.xyz" \
  ALLOWED_ORIGINS="https://app.araf.xyz"
```

Deploy backend:

```bash
fly deploy
```

### Step 5 — Production Frontend Configuration

```bash
cat > frontend/.env.production << 'EOF'
VITE_API_URL=https://api.araf.xyz
VITE_ESCROW_ADDRESS=<MAINNET_ESCROW>
VITE_USDT_ADDRESS=0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
VITE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
EOF
```

Deploy:

```bash
cd frontend
vercel --prod
```

### Mainnet Checklist

- [ ] Audit findings are resolved
- [ ] Gnosis Safe is configured
- [ ] Production encryption is live and tested
- [ ] `NODE_ENV=production` used during deploy
- [ ] `MAINNET_USDT_ADDRESS` and `MAINNET_USDC_ADDRESS` were set
- [ ] Contract verified on BaseScan
- [ ] Ownership transferred to Gnosis Safe
- [ ] `pause()` / `unpause()` tested from Safe
- [ ] Worker is stable on WSS RPC
- [ ] DLQ monitoring exists
- [ ] `/ready` returns OK
- [ ] Frontend uses real Base USDT/USDC addresses
- [ ] SIWE domain and URI match production origin
- [ ] Rate-limit and auth checks passed

---

## 5. Environment Differences Summary

| Parameter | Local | Testnet | Mainnet |
|-----------|-------|---------|---------|
| `NODE_ENV` | `development` | `production` | `production` |
| `KMS_PROVIDER` | `env` | `env` *(temporary)* | `aws` / `vault` |
| `MockERC20` | ✅ Deployed | ✅ Deployed | ❌ Not deployed |
| `CHAIN_ID` | `31337` | `84532` | `8453` |
| `SIWE_DOMAIN` | `localhost:5173` | deployed frontend domain | real domain |
| `SIWE_URI` | `http://localhost:5173` | deployed frontend URL | real production URL |
| Treasury | test wallet | test wallet | Gnosis Safe |
| Relayer | Hardhat wallet | separate test wallet | Gelato recommended |
| RPC | `http://127.0.0.1:8545` | Base Sepolia RPC | Base Mainnet RPC |
| WSS RPC | optional | recommended | strongly recommended |
| Audit | no | no | **mandatory** |

### Quick Commands

```bash
# Contracts test
cd contracts && npx hardhat test

# Local deploy
cd contracts && npx hardhat run scripts/deploy.js --network localhost

# Testnet deploy
cd contracts && npx hardhat run scripts/deploy.js --network base-sepolia

# Mainnet deploy
cd contracts && NODE_ENV=production npx hardhat run scripts/deploy.js --network base

# Backend logs
fly logs --app araf-protocol-backend

# Backend health
curl http://localhost:4000/health
curl http://localhost:4000/ready

# Frontend deploy
cd frontend && vercel --prod
```

---

*Araf Protocol — “Trust the Time, Not the Oracle.”*
