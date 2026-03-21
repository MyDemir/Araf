# Araf Protocol — Deployment Guide

> **Versiyon:** 2.0 | **Son Güncelleme:** Mart 2026
>
> Bu rehber üç ortamı kapsar: Yerel Geliştirme · Public Testnet (Base Sepolia) · Mainnet (Base)

---

## İçindekiler

1. [Yerel Geliştirme (Local)](#1-yerel-geliştirme)
2. [Sık Karşılaşılan Yerel Sorunlar (Troubleshooting)](#2-sık-karşılaşılan-yerel-sorunlar-troubleshooting)
3. [Public Testnet — Base Sepolia](#3-public-testnet--base-sepolia)
4. [Mainnet — Base](#4-mainnet--base)
5. [Ortam Farkları Özeti](#5-ortam-farkları-özeti)

---

## 1. Yerel Geliştirme

### Ön Gereksinimler
- Node.js `v18+`
- Docker Desktop (MongoDB ve Redis için en kolay yöntem)
- MetaMask — Hardhat ağı eklenecek

### Adım 1 — Veritabanı ve Önbellek (Docker İle Kurulum)
Backend'in çalışabilmesi için MongoDB ve Redis'in ayakta olması şarttır. Docker yüklüyse terminalde şu komutları çalıştırarak arka planda başlatabilirsiniz:

```bash
# MongoDB'yi başlat
docker run -d --name araf-mongo -p 27017:27017 mongo:latest

# Redis'i başlat
docker run -d --name araf-redis -p 6379:6379 redis:latest
```
*(Durdurmak için: `docker stop araf-mongo araf-redis`)*

### Adım 2 — Bağımlılıkları Kur

```bash
# Proje kök dizininde
cd contracts && npm install && cd ..
cd backend  && npm install && cd ..
cd frontend && npm install && cd ..
```

### Adım 3 — Terminal 1: Hardhat Node

```bash
cd contracts
npx hardhat node
```

Çıktıda 20 test cüzdanı ve private key'leri listelenir. `Account #0` deployer, `Account #1` treasury olarak kullanılacak.

### Adım 4 — Terminal 2: Kontratları Deploy Et

```bash
# contracts/.env dosyası oluştur
cat > contracts/.env << 'EOF'
# Account #1 adresini buraya yaz
TREASURY_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
# Account #0 private key
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
EOF

npx hardhat run scripts/deploy.js --network hardhat
```

Çıktıdan şu değerleri not al:
```text
VITE_ESCROW_ADDRESS="0x..."
VITE_USDT_ADDRESS="0x..."
VITE_USDC_ADDRESS="0x..."
```

### Adım 5 — Terminal 2: Backend Konfigürasyonu

```bash
# backend/.env dosyası oluştur
cat > backend/.env << 'EOF'
PORT=4000
NODE_ENV=development

MONGODB_URI=mongodb://127.0.0.1:27017/araf_dev
REDIS_URL=redis://127.0.0.1:6379

# Minimum 64 karakter üret:
# node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=bunu_kendin_olustur_64_karakter
JWT_EXPIRES_IN=15m
PII_TOKEN_EXPIRES_IN=15m

KMS_PROVIDER=env
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MASTER_ENCRYPTION_KEY=bunu_kendin_olustur_32_byte

BASE_RPC_URL=[http://127.0.0.1:8545](http://127.0.0.1:8545)
ARAF_ESCROW_ADDRESS=<deploy_ciktisindaki_adres>
CHAIN_ID=31337

TREASURY_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

# Relayer için Account #2 private key'ini kullan
RELAYER_PRIVATE_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

SIWE_DOMAIN=localhost
ALLOWED_ORIGINS=http://localhost:5173
EOF

cd backend && npm run dev
```

### Adım 6 — Terminal 3: Frontend Konfigürasyonu

```bash
# frontend/.env.development dosyası oluştur
cat > frontend/.env.development << 'EOF'
VITE_API_URL=http://localhost:4000
VITE_ESCROW_ADDRESS=<deploy_ciktisindaki_adres>
VITE_USDT_ADDRESS=<deploy_ciktisindaki_usdt_adresi>
VITE_USDC_ADDRESS=<deploy_ciktisindaki_usdc_adresi>
EOF

cd frontend && npm run dev
```

### Adım 7 — MetaMask Hardhat Ağı Ekle

| Alan | Değer |
|------|-------|
| Ağ Adı | Hardhat Local |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Para Birimi | ETH |

MetaMask'a Hardhat'in verdiği test private key'lerini import et.

### Adım 8 — Testleri Çalıştır

```bash
cd contracts

# K-04/K-05 fix'leri dahil — tüm testler geçmeli
npx hardhat test

# Coverage raporu (opsiyonel)
npx hardhat coverage
```

### Yerel Test Kontrol Listesi

- [ ] `npx hardhat node` — 20 hesap görünüyor
- [ ] `npx hardhat test` — tüm testler ✅
- [ ] Backend `http://localhost:4000/health` → `{"status":"ok"}`
- [ ] Frontend `http://localhost:5173` — açılıyor
- [ ] MetaMask Hardhat ağında — `chainId: 31337`
- [ ] Test USDT Al butonu — mock faucet çalışıyor
- [ ] Tam işlem döngüsü: create → lock → pay → release

---

## 2. Sık Karşılaşılan Yerel Sorunlar (Troubleshooting)

Yerel ortamda (veya Codespace'te) geliştirme yaparken en sık karşılaşılan sorunlar ve çözümleri:

### ❌ Port Zaten Kullanımda (EADDRINUSE)
Backend (`4000`) veya Frontend (`5173`) başlatılırken bu hatayı alırsanız, arka planda açık kalmış ve "zombi" olmuş bir Node.js süreci vardır. 

**Çözüm (Portu Serbest Bırakmak):**
```bash
# Mac ve Linux için (Tüm node süreçlerini sonlandırır):
killall -9 node

# Windows için (PowerShell):
taskkill /F /IM node.exe
```
Eğer sadece belirli bir portu (örneğin 4000) öldürmek isterseniz:
```bash
# Mac/Linux:
lsof -i :4000
kill -9 <PID_NUMARASI>
```

### ❌ MetaMask Nonce Hatası (İşlem Askıda Kalıyor)
Hardhat node'unu (Terminal 1) kapatıp tekrar açtığınızda blockchain "sıfırlanır". Ancak MetaMask cüzdanınız eski işlemlerin sırasını (Nonce) hatırlar. Bu yüzden yeni işlem göndermek istediğinizde cüzdan kilitlenir.

**Çözüm (Cüzdanı Sıfırlamak):**
1. MetaMask uzantısını açın.
2. Sağ üstteki üç noktadan (veya profil resminden) **Ayarlar**'a girin.
3. **Gelişmiş** sekmesine tıklayın.
4. **"Hesap Etkinliğini Temizle"** (Clear Activity Data) butonuna basın. (Bu işlem bakiyenizi veya hesaplarınızı silmez, sadece işlem geçmişini sıfırlar).

### ❌ Codespaces Kaynak Limitleri (Resource Pressure)
GitHub Codespaces (Ücretsiz sürüm), MongoDB, Redis, Hardhat, Backend ve Frontend'i aynı anda çalıştırırken RAM (Bellek) sınırlarını hızla zorlayabilir. Codespace kilitlenir veya terminal donarsa:

**Çözüm:**
1. Geçici Olarak Docker'ları Durdurun: Eğer sadece Frontend tasarlıyorsanız backend/veritabanı ikilisini kapatın: `docker stop araf-mongo araf-redis`.
2. Projeyi Bilgisayarınıza Alın (Önerilen): Eğer tam entegrasyon testleri yapacaksanız, projeyi `git clone` ile doğrudan kendi bilgisayarınıza çekip (Docker Desktop ile) kısıtlama olmadan çalışın.

### 🔎 Hataları Merkezi Olarak İzlemek
Oluşturduğumuz hata yakalama sistemi sayesinde, (UI çökmeleri, kontrat iptalleri, API retleri dahil) tüm sistem olayları tek bir dosyada birikir. Geliştirme yaparken her zaman bir terminal sekmesinde bu logu açık tutun:

```bash
# Kök dizinde (veya backend dizininde)
tail -f araf_full_stack.log.txt
```

---

## 3. Public Testnet — Base Sepolia

### Ön Gereksinimler
- Metamask'ta Base Sepolia ağı
- Base Sepolia ETH (Faucet: `faucet.quicknode.com` veya `sepoliafaucet.com`)
- Alchemy/Infura hesabı (RPC için)
- MongoDB Atlas hesabı (free M0)
- Upstash Redis hesabı (free)
- Fly.io hesabı (backend için)
- Vercel hesabı (frontend için)
- BaseScan API key (`basescan.org/myapikey`)

### Adım 1 — Kontrat Deploy (Base Sepolia)

```bash
# contracts/.env güncelle
cat > contracts/.env << 'EOF'
DEPLOYER_PRIVATE_KEY=0x<testnet_deployer_private_key>
TREASURY_ADDRESS=0x<testnet_treasury_wallet>
BASE_SEPOLIA_RPC_URL=[https://base-sepolia.g.alchemy.com/v2/](https://base-sepolia.g.alchemy.com/v2/)<API_KEY>
BASESCAN_API_KEY=<basescan_api_key>
REPORT_GAS=true
EOF

cd contracts

# Compile
npx hardhat compile

# Deploy
npx hardhat run scripts/deploy.js --network base-sepolia
```

Çıktıdan not alınacaklar:
```text
✅ ArafEscrow deploy edildi: 0x...
✅ MockUSDT deploy edildi:    0x...
✅ MockUSDC deploy edildi:    0x...
✅ Ownership devredildi →     0x<treasury>
```

### Adım 2 — Kontrat Doğrulama (BaseScan)

```bash
cd contracts

# ArafEscrow doğrula
npx hardhat verify --network base-sepolia \
  <ARAF_ESCROW_ADDRESS> \
  <TREASURY_ADDRESS>

# MockUSDT doğrula
npx hardhat verify --network base-sepolia \
  <USDT_ADDRESS> \
  "Mock USDT" "USDT" 6

# MockUSDC doğrula
npx hardhat verify --network base-sepolia \
  <USDC_ADDRESS> \
  "Mock USDC" "USDC" 6
```

### Adım 3 — Backend: Fly.io Deploy

```bash
# Fly.io CLI kur (macOS/Linux)
curl -L [https://fly.io/install.sh](https://fly.io/install.sh) | sh

# Giriş yap
fly auth login

# backend dizinine git
cd backend

# Uygulama oluştur (ilk kez)
fly apps create araf-protocol-backend

# Gizli değişkenleri set et (tek seferde)
fly secrets set \
  NODE_ENV="production" \
  MONGODB_URI="mongodb+srv://<user>:<pass>@cluster.mongodb.net/araf_testnet" \
  REDIS_URL="rediss://:<token>@<host>.upstash.io:6379" \
  JWT_SECRET="<64_karakter_hex>" \
  JWT_EXPIRES_IN="15m" \
  PII_TOKEN_EXPIRES_IN="15m" \
  KMS_PROVIDER="env" \
  MASTER_ENCRYPTION_KEY="<32_byte_hex>" \
  BASE_RPC_URL="[https://base-sepolia.g.alchemy.com/v2/](https://base-sepolia.g.alchemy.com/v2/)<API_KEY>" \
  BASE_WS_RPC_URL="wss://[base-sepolia.g.alchemy.com/v2/](https://base-sepolia.g.alchemy.com/v2/)<API_KEY>" \
  ARAF_ESCROW_ADDRESS="<DEPLOY_ADRES>" \
  CHAIN_ID="84532" \
  TREASURY_ADDRESS="<TREASURY_WALLET>" \
  RELAYER_PRIVATE_KEY="0x<relayer_private_key>" \
  SIWE_DOMAIN="araf-protocol-backend.fly.dev" \
  ALLOWED_ORIGINS="[https://araf-protocol.vercel.app](https://araf-protocol.vercel.app)"

# Deploy et
fly deploy

# Logları izle
fly logs --app araf-protocol-backend
```

> **Not:** `fly.toml` dosyasındaki `auto_stop_machines = false` ayarı event listener'ın sürekli çalışması için zorunludur. Değiştirme.

### Adım 4 — Frontend: Vercel Deploy

```bash
# Vercel CLI kur
npm install -g vercel

# frontend dizinine git
cd frontend

# vercel.json'daki proxy URL'ini güncelle
# "destination" → "[https://araf-protocol-backend.fly.dev/api/$1](https://araf-protocol-backend.fly.dev/api/$1)"

# Production env dosyası oluştur
cat > .env.production << 'EOF'
VITE_API_URL=[https://araf-protocol-backend.fly.dev](https://araf-protocol-backend.fly.dev)
VITE_ESCROW_ADDRESS=<DEPLOY_ADRES>
VITE_USDT_ADDRESS=<USDT_ADRES>
VITE_USDC_ADDRESS=<USDC_ADRES>
EOF

# Deploy et
vercel --prod

# veya GitHub entegrasyonu ile otomatik deploy için:
# vercel link → GitHub repo bağla → her main push'ta otomatik deploy
```

Vercel'de Environment Variables olarak da set edilmeli (Dashboard → Settings → Environment Variables).

### Adım 5 — SIWE Domain Güncelleme

Backend deploy URL'i belli olduktan sonra:

```bash
# Backend'de SIWE_DOMAIN'i frontend domain'i yap
fly secrets set SIWE_DOMAIN="araf-protocol.vercel.app"
```

### Adım 6 — main.jsx Hardhat Chain'i Kaldır

```jsx
// frontend/src/main.jsx — testnet için hardhat chain gerekmiyor
import { base, baseSepolia } from 'wagmi/chains'
// hardhat import'u kaldır

const config = createConfig({
  chains: [base, baseSepolia], // hardhat kaldırıldı
  transports: {
    [base.id]:       http(),
    [baseSepolia.id]: http(),
  },
})
```

### Testnet Kontrol Listesi

- [ ] `https://sepolia.basescan.org/address/<ESCROW_ADDRESS>` — kontrat verified ✅
- [ ] `https://araf-protocol-backend.fly.dev/health` → `{"status":"ok","worker":"active"}`
- [ ] `https://araf-protocol.vercel.app` — site açılıyor
- [ ] MetaMask Base Sepolia'ya bağlı
- [ ] Test USDT/USDC faucet çalışıyor
- [ ] SIWE login başarılı
- [ ] Tam işlem döngüsü: create → lock → pay → release
- [ ] Dispute → bleeding → cancel
- [ ] Event listener logları temiz (`fly logs`)

---

## 4. Mainnet — Base

> ⚠️ **Mainnet öncesi zorunlu:** Profesyonel akıllı kontrat güvenlik denetimi (audit) tamamlanmış olmalıdır.

### Testnet vs Mainnet Farkları

| Alan | Testnet | Mainnet |
|------|---------|---------|
| MockERC20 | Deploy edilir | **Deploy edilmez** (`NODE_ENV=production`) |
| KMS | `env` (geçici) | AWS KMS veya HashiCorp Vault |
| Treasury | Test wallet | **Gnosis Safe multisig** (min 3/5) |
| RPC | Alchemy Sepolia | Alchemy/Infura Base Mainnet |
| Chain ID | 84532 | 8453 |
| Relayer | Manuel wallet | Gelato Automation (önerilen) |
| Audit | Opsiyonel | **Zorunlu** |

### Adım 1 — Gnosis Safe Hazırlığı

1. `safe.global` → Base Mainnet → Yeni Safe
2. Minimum 3/5 imzacı yapılandır
3. Safe adresini `TREASURY_ADDRESS` olarak kullan
4. **Tek EOA treasury kullanma** — private key sızarsa tüm protokol fonları risk altına girer

### Adım 2 — AWS KMS Kurulumu (Üretim Şifreleme)

```bash
# AWS CLI ile KMS anahtarı oluştur
aws kms create-key \
  --description "Araf Protocol PII Master Key" \
  --region eu-west-1

# Veri anahtarı üret (plaintext + şifreli)
aws kms generate-data-key \
  --key-id <KMS_KEY_ARN> \
  --key-spec AES_256 \
  --region eu-west-1

# Çıktıdan şifreli veri anahtarını al (CiphertextBlob → base64)
# AWS_ENCRYPTED_DATA_KEY değişkenine kaydet
```

### Adım 3 — Kontrat Deploy (Base Mainnet)

```bash
# contracts/.env güncelle
cat > contracts/.env << 'EOF'
DEPLOYER_PRIVATE_KEY=0x<mainnet_deployer_private_key>
TREASURY_ADDRESS=0x<gnosis_safe_address>
BASE_RPC_URL=[https://base-mainnet.g.alchemy.com/v2/](https://base-mainnet.g.alchemy.com/v2/)<API_KEY>
BASESCAN_API_KEY=<basescan_api_key>
EOF

# NODE_ENV production set et ki MockERC20 deploy edilmesin
NODE_ENV=production npx hardhat run scripts/deploy.js --network base

# Verify et
npx hardhat verify --network base <ESCROW_ADDRESS> <GNOSIS_SAFE_ADDRESS>
```

### Adım 4 — Backend: Üretim Secrets

```bash
# Fly.io production secrets
fly secrets set \
  NODE_ENV="production" \
  KMS_PROVIDER="aws" \
  AWS_KMS_KEY_ARN="arn:aws:kms:eu-west-1:...:key/..." \
  AWS_ENCRYPTED_DATA_KEY="<base64_CiphertextBlob>" \
  AWS_REGION="eu-west-1" \
  BASE_RPC_URL="[https://base-mainnet.g.alchemy.com/v2/](https://base-mainnet.g.alchemy.com/v2/)<API_KEY>" \
  BASE_WS_RPC_URL="wss://[base-mainnet.g.alchemy.com/v2/](https://base-mainnet.g.alchemy.com/v2/)<API_KEY>" \
  CHAIN_ID="8453" \
  ARAF_ESCROW_ADDRESS="<MAINNET_ESCROW>" \
  TREASURY_ADDRESS="<GNOSIS_SAFE>" \
  SIWE_DOMAIN="app.araf.xyz" \
  ALLOWED_ORIGINS="[https://app.araf.xyz](https://app.araf.xyz)"
  # RELAYER_PRIVATE_KEY → Mainnet'te Gelato Automation kullan

fly deploy
```

### Adım 5 — Frontend Üretim Konfigürasyonu

```bash
# main.jsx — sadece mainnet
import { base } from 'wagmi/chains'

# .env.production
VITE_API_URL=[https://api.araf.xyz](https://api.araf.xyz)
VITE_ESCROW_ADDRESS=<MAINNET_ESCROW>
# VITE_USDT_ADDRESS ve VITE_USDC_ADDRESS → gerçek Base USDT/USDC adresleri
# Base USDT: 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
# Base USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

vercel --prod
```

### Mainnet Kontrol Listesi

- [ ] Güvenlik denetimi raporu hazır ve bulguları kapatılmış
- [ ] Gnosis Safe multisig yapılandırılmış (min 3/5)
- [ ] AWS KMS aktif ve şifreli data key test edilmiş
- [ ] `NODE_ENV=production` — MockERC20 deploy edilmedi ✅
- [ ] Kontrat verified on BaseScan
- [ ] Ownership Gnosis Safe'e devredildi ✅
- [ ] `pause()` / `unpause()` Gnosis Safe'ten çalışıyor
- [ ] Event listener WSS RPC üzerinde stabil
- [ ] DLQ monitörü alert webhook aktif (Slack/PagerDuty)
- [ ] `GET /health` → worker: active
- [ ] Gerçek USDT/USDC adresleri frontend'de doğru
- [ ] SIWE domain production domain'e eşleşiyor
- [ ] Rate limit testleri geçti

---

## 5. Ortam Farkları Özeti

| Parametre | Local | Testnet | Mainnet |
|-----------|-------|---------|---------|
| `NODE_ENV` | `development` | `production` | `production` |
| `KMS_PROVIDER` | `env` | `env` *(geçici)* | `aws` / `vault` |
| `MockERC20` | ✅ Deploy | ✅ Deploy | ❌ Deploy edilmez |
| `CHAIN_ID` | `31337` | `84532` | `8453` |
| `SIWE_DOMAIN` | `localhost` | `*.fly.dev` / `*.vercel.app` | gerçek domain |
| Treasury | Test wallet | Test wallet | Gnosis Safe |
| Relayer | Hardhat wallet | Ayrı test wallet | Gelato Automation |
| RPC | `http://localhost:8545` | Alchemy Sepolia | Alchemy/Infura Base |
| WSS RPC | Gerekmiyor | Önerilen | **Zorunlu** |
| Audit | Hayır | Hayır | **Zorunlu** |

### Hızlı Komut Referansı

```bash
# Testler
cd contracts && npx hardhat test

# Local deploy
npx hardhat run scripts/deploy.js --network hardhat

# Testnet deploy
npx hardhat run scripts/deploy.js --network base-sepolia

# Mainnet deploy
NODE_ENV=production npx hardhat run scripts/deploy.js --network base

# Verify (testnet)
npx hardhat verify --network base-sepolia <ADDRESS> <TREASURY>

# Fly.io backend logs
fly logs --app araf-protocol-backend

# Fly.io secret güncelle
fly secrets set KEY=VALUE

# Vercel production deploy
cd frontend && vercel --prod
```

### Yararlı Linkler

| Servis | Link |
|--------|------|
| Base Sepolia Faucet | `faucet.quicknode.com` |
| BaseScan Testnet | `sepolia.basescan.org` |
| BaseScan Mainnet | `basescan.org` |
| Alchemy | `dashboard.alchemy.com` |
| Fly.io Dashboard | `fly.io/dashboard` |
| Vercel Dashboard | `vercel.com/dashboard` |
| Gnosis Safe | `app.safe.global` |
| AWS KMS | `console.aws.amazon.com/kms` |

---

*Araf Protocol — "Trust the Time, Not the Oracle."*
