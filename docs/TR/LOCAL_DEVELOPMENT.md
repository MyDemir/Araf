# Araf Protocol — Kurulum ve Dağıtım Rehberi

> **Versiyon:** 2.1  
> **Son Güncelleme:** Mart 2026  
> Bu rehber üç ortamı kapsar: **Yerel Geliştirme** · **Public Testnet (Base Sepolia)** · **Mainnet (Base)**

---

## İçindekiler

1. [Yerel Geliştirme](#1-yerel-geliştirme)
2. [Sık Karşılaşılan Yerel Sorunlar (Troubleshooting)](#2-sık-karşılaşılan-yerel-sorunlar-troubleshooting)
3. [Public Testnet — Base Sepolia](#3-public-testnet--base-sepolia)
4. [Mainnet — Base](#4-mainnet--base)
5. [Ortam Farkları Özeti](#5-ortam-farkları-özeti)

---

## 1. Yerel Geliştirme

Yerel geliştirme artık **chain-first** mantıkla test edilmelidir.

Önemli local kurallar:
- Ayrı bir Hardhat node çalıştırıyorsan deploy hedefi **`hardhat` değil `localhost`** olmalıdır.
- `/health` yalnızca **liveness** endpoint’idir.
- Asıl **readiness** endpoint’i `/ready`’dir.
- Local SIWE akışı açık `SIWE_DOMAIN` + `SIWE_URI` çiftiyle çalışmalıdır.
- İlan oluşturma artık **`listing_ref`** üzerinden authoritative bağ kurar:
  - backend `listing_ref` üretir
  - frontend `createEscrow(..., listingRef)` çağırır
  - worker `EscrowCreated(..., listingRef)` event’i ile doğru ilanı bağlar

### Ön Gereksinimler
- Node.js `v18+`
- Docker Desktop (MongoDB ve Redis için önerilir)
- MetaMask

### Adım 1 — MongoDB ve Redis’i Başlat

```bash
docker run -d --name araf-mongo -p 27017:27017 mongo:latest
docker run -d --name araf-redis -p 6379:6379 redis:latest
```

Durdurmak için:

```bash
docker stop araf-mongo araf-redis
```

### Adım 2 — Bağımlılıkları Kur

```bash
cd contracts && npm install && cd ..
cd backend  && npm install && cd ..
cd frontend && npm install && cd ..
```

### Adım 3 — Terminal 1: Hardhat Node’u Başlat

```bash
cd contracts
npx hardhat node
```

Bu komut 20 adet fonlanmış test cüzdanı üretir.

Önerilen kullanım:
- `Account #0` → deployer
- `Account #1` → treasury
- `Account #2` → relayer

### Adım 4 — Terminal 2: Kontratları `localhost` Ağına Deploy Et

`contracts/.env` oluştur:

```bash
cat > contracts/.env << 'EOF'
TREASURY_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
EOF
```

Deploy komutu:

```bash
cd contracts
npx hardhat run scripts/deploy.js --network localhost
```

Çıktıdan şu değerleri not al:

```text
VITE_ESCROW_ADDRESS=0x...
VITE_USDT_ADDRESS=0x...
VITE_USDC_ADDRESS=0x...
```

### Adım 5 — Terminal 3: Backend Konfigürasyonu

`backend/.env` oluştur:

```bash
cat > backend/.env << 'EOF'
PORT=4000
NODE_ENV=development

MONGODB_URI=mongodb://127.0.0.1:27017/araf_dev
REDIS_URL=redis://127.0.0.1:6379

# Güçlü bir secret üret:
# node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=<GERCEK_64+_KARAKTER_SECRET>
JWT_EXPIRES_IN=15m
PII_TOKEN_EXPIRES_IN=15m

KMS_PROVIDER=env
# 32 byte hex üret:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MASTER_ENCRYPTION_KEY=<GERCEK_32_BYTE_HEX_KEY>

BASE_RPC_URL=http://127.0.0.1:8545
ARAF_ESCROW_ADDRESS=<DEPLOY_CIKTISINDAKI_ESCROW_ADRESI>
CHAIN_ID=31337
TREASURY_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
RELAYER_PRIVATE_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

SIWE_DOMAIN=localhost:5173
SIWE_URI=http://localhost:5173
ALLOWED_ORIGINS=http://localhost:5173

# Local davranışı netleştirmek için opsiyonel ama önerilir
WORKER_START_BLOCK=0
EOF
```

Backend’i başlat:

```bash
cd backend
npm run dev
```

### Adım 6 — Terminal 4: Frontend Konfigürasyonu

`frontend/.env.development` oluştur:

```bash
cat > frontend/.env.development << 'EOF'
VITE_API_URL=http://localhost:4000
VITE_ESCROW_ADDRESS=<DEPLOY_CIKTISINDAKI_ESCROW_ADRESI>
VITE_USDT_ADDRESS=<DEPLOY_CIKTISINDAKI_USDT_ADRESI>
VITE_USDC_ADDRESS=<DEPLOY_CIKTISINDAKI_USDC_ADRESI>
EOF
```

Frontend’i başlat:

```bash
cd frontend
npm run dev
```

### Adım 7 — MetaMask’a Hardhat Local Ağı Ekle

| Alan | Değer |
|------|-------|
| Ağ Adı | Hardhat Local |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Para Birimi | ETH |

Hardhat test private key’lerini MetaMask’a import et.

### Adım 8 — Kontrat Testlerini Çalıştır

```bash
cd contracts
npx hardhat test
npx hardhat coverage
```

### Adım 9 — Local Full-Stack Smoke Test

Şu akışı baştan sona test et:

1. Frontend’i `http://localhost:5173` adresinde aç
2. Backend liveness kontrolü yap:
   - `GET http://localhost:4000/health`
3. Backend readiness kontrolü yap:
   - `GET http://localhost:4000/ready`
4. MetaMask’ı `31337` ağına bağla
5. SIWE login yap
6. UI üzerinden test USDT/USDC mint et
7. Maker olarak ilan oluştur
8. Backend’in `listing_ref` ürettiğini doğrula
9. Frontend’in `createEscrow(token, amount, tier, listingRef)` çağrısı yaptığını doğrula
10. Worker’ın `EscrowCreated(..., listingRef)` event’i ile doğru ilanı bağladığını doğrula
11. Taker olarak trade’e gir
12. Receipt upload et
13. `reportPayment` çağır
14. Maker olarak `releaseFunds` yap
15. Ayrı olarak şunları da test et:
   - cancel flow
   - challenge flow
   - bleeding flow
   - DLQ boş mu veya beklenen test kayıtları dışında temiz mi

### Yerel Geliştirme Kontrol Listesi

- [ ] `npx hardhat node` çalışıyor
- [ ] `npx hardhat test` geçiyor
- [ ] `GET /health` liveness OK dönüyor
- [ ] `GET /ready` readiness OK dönüyor
- [ ] Frontend `http://localhost:5173` açılıyor
- [ ] MetaMask `chainId: 31337`
- [ ] SIWE login başarılı
- [ ] Mock faucet çalışıyor
- [ ] `listing_ref` üretiliyor
- [ ] `createEscrow(..., listingRef)` başarılı
- [ ] Worker `EscrowCreated(..., listingRef)` event’ini doğru bağlıyor
- [ ] Full trade lifecycle çalışıyor: create → lock → pay → release
- [ ] Cancel flow çalışıyor
- [ ] Challenge / bleeding flow çalışıyor
- [ ] DLQ temiz veya anlaşılır durumda

---

## 2. Sık Karşılaşılan Yerel Sorunlar (Troubleshooting)

### ❌ Port Kullanımda (`EADDRINUSE`)

Backend (`4000`) veya frontend (`5173`) portu doluysa:

```bash
# macOS / Linux
killall -9 node

# Windows PowerShell
taskkill /F /IM node.exe
```

Tek port temizlemek için:

```bash
# macOS / Linux
lsof -i :4000
kill -9 <PID>
```

### ❌ MetaMask Nonce / Askıda Kalan İşlem

Hardhat node yeniden başlatıldığında zincir sıfırlanır, ama MetaMask eski nonce geçmişini tutar.

Çözüm:
1. MetaMask’ı aç
2. **Settings** bölümüne gir
3. **Advanced** sekmesini aç
4. **Clear Activity Data** butonuna bas

### ❌ `/health` geçiyor ama `/ready` geçmiyor

Bu normal olabilir. Uygulama yaşıyor olabilir ama gerçekten hazır değildir.

Olası sebepler:
- MongoDB bağlı değil
- Redis bağlı değil
- worker çalışmıyor
- `SIWE_DOMAIN` / `SIWE_URI` yanlış
- `ARAF_ESCROW_ADDRESS` eksik
- `BASE_RPC_URL` eksik

Gerçek entegrasyon sağlığını anlamak için `/health` değil `/ready` kullan.

### ❌ Local SIWE Login Başarısız

Önce şunları kontrol et:
- `SIWE_DOMAIN=localhost:5173`
- `SIWE_URI=http://localhost:5173`
- `ALLOWED_ORIGINS=http://localhost:5173`
- frontend gerçekten `http://localhost:5173` adresinden açılıyor mu

Bunlar farklıysa backend exact-origin SIWE doğrulaması login’i reddeder.

### ❌ Listing Oluştu Ama Worker Bağlayamadı

Şunları kontrol et:
- listing’de `listing_ref` var mı
- frontend bu `listing_ref` değerini `createEscrow` çağrısına taşıyor mu
- worker `EscrowCreated(..., listingRef)` event’ini görüyor mu
- worker/provider çalışıyor mu, `/ready` sağlıklı mı

`listing_ref` eksik veya hatalıysa sistem heuristik bağ kurmamalı; fail-closed davranmalıdır.

### ❌ Codespaces Kaynak Baskısı

MongoDB, Redis, Hardhat, backend ve frontend aynı anda çalışınca düşük kaynaklı Codespaces oturumu donabilir.

Azaltma yöntemleri:
1. Gerekmediğinde Docker container’larını kapat:
   ```bash
   docker stop araf-mongo araf-redis
   ```
2. Full-stack entegrasyon ve dispute testleri için mümkünse local makinede çalış.

### 🔎 Merkezi Hata İzleme

Test sırasında logları açık tut:

```bash
tail -f araf_full_stack.log.txt
```

---

## 3. Public Testnet — Base Sepolia

### Ön Gereksinimler
- MetaMask’ta Base Sepolia ağı
- Faucet’ten Base Sepolia ETH
- Alchemy / Infura hesabı
- MongoDB Atlas
- Upstash Redis
- Fly.io hesabı
- Vercel hesabı
- BaseScan API key

### Adım 1 — Kontrat Deploy

`contracts/.env` oluştur:

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

Beklenen çıktı:
- `ArafEscrow` adresi
- `MockUSDT` adresi
- `MockUSDC` adresi
- ownership transfer onayı

### Adım 2 — BaseScan Verify

```bash
cd contracts

npx hardhat verify --network base-sepolia <ARAF_ESCROW_ADDRESS> <TREASURY_ADDRESS>
npx hardhat verify --network base-sepolia <USDT_ADDRESS> "Mock USDT" "USDT" 6
npx hardhat verify --network base-sepolia <USDC_ADDRESS> "Mock USDC" "USDC" 6
```

### Adım 3 — Backend’i Fly.io’ya Deploy Et

```bash
cd backend
fly apps create araf-protocol-backend

fly secrets set \
  NODE_ENV="production" \
  MONGODB_URI="mongodb+srv://<user>:<pass>@cluster.mongodb.net/araf_testnet" \
  REDIS_URL="rediss://:<token>@<host>.upstash.io:6379" \
  JWT_SECRET="<64+_KARAKTER_SECRET>" \
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

İlk deploy ise ve Redis’te checkpoint yoksa bir kez seed et:

```bash
redis-cli -u "$REDIS_URL" SET worker:last_block "$ARAF_DEPLOYMENT_BLOCK"
```

### Adım 4 — Frontend’i Vercel’e Deploy Et

`frontend/.env.production` oluştur:

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

### Adım 5 — Testnet Kontrol Listesi

- [ ] Kontratlar BaseScan’de verified
- [ ] Backend `/health` cevap veriyor
- [ ] Backend `/ready` OK dönüyor
- [ ] Frontend açılıyor
- [ ] MetaMask Base Sepolia’ya bağlı
- [ ] SIWE login başarılı
- [ ] Mock USDT/USDC faucet çalışıyor
- [ ] Full lifecycle çalışıyor: create → lock → pay → release
- [ ] Challenge / bleeding / cancel akışları çalışıyor
- [ ] `listing_ref` akışı uçtan uca çalışıyor
- [ ] Fly logları temiz

---

## 4. Mainnet — Base

> **Mainnet öncesi zorunlu:** profesyonel güvenlik denetimini tamamla ve bulguları kapat.

### Testnet ve Mainnet Farkları

| Alan | Testnet | Mainnet |
|------|---------|---------|
| MockERC20 | Deploy edilir | **Deploy edilmez** (`NODE_ENV=production`) |
| KMS | `env` (geçici) | AWS KMS veya HashiCorp Vault |
| Treasury | test wallet | **Gnosis Safe multisig** |
| RPC | Sepolia RPC | Base Mainnet RPC |
| Chain ID | `84532` | `8453` |
| Relayer | manuel wallet | Gelato önerilir |
| Audit | opsiyonel | **zorunlu** |

### Adım 1 — Treasury Hazırlığı

Base Mainnet üzerinde Gnosis Safe kullan.

Minimum öneri:
- 3/5 multisig

Production’da tek EOA treasury kullanma.

### Adım 2 — Production Şifreleme Hazırlığı

Önerilen:
- AWS KMS
- veya HashiCorp Vault

### Adım 3 — Kontrat Deploy

`contracts/.env` oluştur:

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

### Adım 4 — Production Backend Konfigürasyonu

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

Backend deploy:

```bash
fly deploy
```

### Adım 5 — Production Frontend Konfigürasyonu

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

### Mainnet Kontrol Listesi

- [ ] Audit bulguları kapatıldı
- [ ] Gnosis Safe yapılandırıldı
- [ ] Production encryption canlı ve test edildi
- [ ] Deploy sırasında `NODE_ENV=production` kullanıldı
- [ ] `MAINNET_USDT_ADDRESS` ve `MAINNET_USDC_ADDRESS` tanımlandı
- [ ] Kontrat BaseScan’de verified
- [ ] Ownership Gnosis Safe’e devredildi
- [ ] `pause()` / `unpause()` Safe üzerinden test edildi
- [ ] Worker WSS RPC üzerinde stabil
- [ ] DLQ monitoring mevcut
- [ ] `/ready` OK dönüyor
- [ ] Frontend gerçek Base USDT/USDC adreslerini kullanıyor
- [ ] SIWE domain ve URI production origin ile eşleşiyor
- [ ] Rate-limit ve auth kontrolleri geçti

---

## 5. Ortam Farkları Özeti

| Parametre | Local | Testnet | Mainnet |
|-----------|-------|---------|---------|
| `NODE_ENV` | `development` | `production` | `production` |
| `KMS_PROVIDER` | `env` | `env` *(geçici)* | `aws` / `vault` |
| `MockERC20` | ✅ Deploy | ✅ Deploy | ❌ Deploy edilmez |
| `CHAIN_ID` | `31337` | `84532` | `8453` |
| `SIWE_DOMAIN` | `localhost:5173` | deploy edilen frontend domain’i | gerçek domain |
| `SIWE_URI` | `http://localhost:5173` | deploy edilen frontend URL’i | gerçek production URL’i |
| Treasury | test wallet | test wallet | Gnosis Safe |
| Relayer | Hardhat wallet | ayrı test wallet | Gelato önerilir |
| RPC | `http://127.0.0.1:8545` | Base Sepolia RPC | Base Mainnet RPC |
| WSS RPC | opsiyonel | önerilir | kuvvetle önerilir |
| Audit | hayır | hayır | **zorunlu** |

### Hızlı Komutlar

```bash
# Kontrat testleri
cd contracts && npx hardhat test

# Local deploy
cd contracts && npx hardhat run scripts/deploy.js --network localhost

# Testnet deploy
cd contracts && npx hardhat run scripts/deploy.js --network base-sepolia

# Mainnet deploy
cd contracts && NODE_ENV=production npx hardhat run scripts/deploy.js --network base

# Backend health
curl http://localhost:4000/health
curl http://localhost:4000/ready

# Backend logs
fly logs --app araf-protocol-backend

# Frontend deploy
cd frontend && vercel --prod
```

---

*Araf Protocol — “Trust the Time, Not the Oracle.”*
