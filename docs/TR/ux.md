# Araf Protocol - Güncel Dosya Yapısı

```
araf-protocol/
│
├── 📄 .gitignore
├── 📄 README.md
│
├── 📁 contracts/                          # Solidity Smart Contract Katmanı
│   ├── 📄 hardhat.config.js               # Hardhat yapılandırması (Base L2, Solidity 0.8.24)
│   ├── 📄 package.json
│   ├── 📄 .env.example                    # Kontrat ortam değişkenleri şablonu
│   │
│   ├── 📁 src/
│   │   ├── 📄 ArafEscrow.sol              # Ana kontrat v2.1 (Bleeding Escrow + Anti-Sybil + EIP-712 + Tier Limits)
│   │   └── 📄 MockERC20.sol               # Test token'ı — faucet mint() + admin mint(address,uint256)
│   │
│   ├── 📁 scripts/
│   │   └── 📄 deploy.js                   # Deploy scripti (ABI otomatik frontend'e kopyalar, ownership devri)
│   │
│   └── 📁 test/
│       └── 📄 ArafEscrow.test.js          # Tam test suite v2.1 (Happy path, Tier Limits K-05, Anti-Sybil, Bleeding, Cancel)
│
├── 📁 backend/                            # Node.js + Express Web2.5 API
│   ├── 📄 package.json
│   ├── 📄 .env.example                    # Ortam değişkenleri şablonu
│   ├── 📄 env.example                     # Alternatif env şablonu (duplicate)
│   ├── 📄 Dockerfile                      # Alpine Node.js üretim imajı
│   ├── 📄 fly.toml                        # Fly.io deploy yapılandırması
│   ├── 📄 .dockerignore
│   │
│   └── 📁 scripts/
│       ├── 📄 app.js                      # Ana uygulama (Bootstrap + Routes + DLQ + Graceful Shutdown)
│       │
│       ├── 📁 config/
│       │   ├── 📄 db.js                   # MongoDB bağlantı yöneticisi (connection pool)
│       │   └── 📄 redis.js                # Redis bağlantı yöneticisi (rate limiting + nonces + DLQ)
│       │
│       ├── 📁 models/
│       │   ├── 📄 User.js                 # Kullanıcı modeli (şifreli PII + reputation cache + ban state)
│       │   ├── 📄 Trade.js                # Listing + Trade şemaları (evidence + receipt TTL + chargeback ack)
│       │   ├── 📄 Feedback.js             # Geri bildirim şeması (kategori + GDPR TTL)
│       │   └── 📄 HistoricalStat.js       # Günlük protokol istatistik anlık görüntüsü (stats endpoint için)
│       │
│       ├── 📁 routes/
│       │   ├── 📄 auth.js                 # SIWE + JWT + httpOnly cookie + profil güncelleme
│       │   ├── 📄 listings.js             # Pazar yeri CRUD (on-chain tier doğrulama + bond config)
│       │   ├── 📄 trades.js               # İşlem odası + EIP-712 cancel + chargeback ack + by-escrow
│       │   ├── 📄 pii.js                  # 🔐 2-adımlı IBAN fetch + /my + /taker-name triangulation
│       │   ├── 📄 receipts.js             # 🔐 Şifreli dekont yükleme (AES-256-GCM + SHA-256 hash)
│       │   ├── 📄 feedback.js             # Kullanıcı geri bildirimi (kategori zorunlu)
│       │   └── 📄 stats.js                # Protokol istatistikleri (Redis 1s cache + 30 günlük karşılaştırma)
│       │   └── 📄 logs.js                # Lig yönetimi 
│       │
│       ├── 📁 middleware/
│       │   ├── 📄 auth.js                 # requireAuth (httpOnly cookie) + requirePIIToken (Bearer)
│       │   ├── 📄 rateLimiter.js          # Redis sliding window (6 seviye: PII/Auth/Listings/Trades/Feedback)
│       │   └── 📄 errorHandler.js         # Global hata yakalayıcı (Mongoose + JWT + generic)
│       │
│       ├── 📁 services/
│       │   ├── 📄 siwe.js                 # SIWE akışı + JWT + refresh token rotation (Redis SCAN)
│       │   ├── 📄 encryption.js           # AES-256-GCM envelope encryption (HKDF + KMS-ready: env/aws/vault)
│       │   ├── 📄 eventListener.js        # Zincir dinleyici (on-chain → MongoDB + FIFO DLQ + checkpoint)
│       │   ├── 📄 dlqProcessor.js         # Dead Letter Queue monitörü (arşiv + alert cooldown)
│       │   └── 📄 protocolConfig.js       # On-chain bond parametrelerini başlangıçta yükler (Redis cache)
│       │
│       ├── 📁 jobs/
│       │   ├── 📄 reputationDecay.js      # 180 günlük temiz sayfa kuralını on-chain'de tetikler (Relayer)
│       │   └── 📄 statsSnapshot.js        # Günlük istatistik anlık görüntüsü (aggregation pipeline)
│       │
│       └── 📁 utils/
│           └── 📄 logger.js               # Winston logger (JSON format, ortama göre log seviyesi)
│
├── 📁 frontend/                           # React + Vite + Tailwind
│   ├── 📄 index.html
│   ├── 📄 package.json
│   ├── 📄 vite.config.js
│   ├── 📄 tailwind.config.js
│   ├── 📄 postcss.config.js
│   ├── 📄 vercel.json                     # Vercel deploy (API proxy + security headers)
│   ├── 📄 .env.example                    # Frontend ortam değişkenleri şablonu
│   │
│   └── 📁 src/
│       ├── 📄 main.jsx                    # Wagmi + React Query Provider (ErrorBoundary sarmalı)
│       ├── 📄 App.jsx                     # 🎨 Ana UI (Marketplace + Trade Room + Profil + SIWE + Cookie auth)
│       ├── 📄 index.css                   # Tailwind + custom animasyonlar (bounce-in, pulse-slow)
│       │
│       ├── 📁 components/
│       │   ├── 📄 ErrorBoundary.jsx       # Global render hata sınırı
│       │   └── 📄 PIIDisplay.jsx          # 🔐 Şifreli IBAN görüntüleme (2-adım + kopyala + Telegram)
│       │
│       ├── 📁 hooks/
│       │   ├── 📄 usePII.js               # 2-adımlı PII fetch (auto-cleanup, cookie-only auth)
│       │   ├── 📄 useArafContract.js      # Tüm kontrat etkileşimleri (write/read/EIP-712, chain guard)
│       │   └── 📄 useCountdown.js         # Hedef tarihe geri sayım hook'u (saniye bazlı)
│       │
│       └── 📁 abi/
│           └── 📄 ArafEscrow.json         # Deploy scripti tarafından otomatik oluşturulur
│
└── 📁 docs/                               # Mimari & Operasyonel Dokümantasyon
│   ├── 📁 tr/                             # Türkçe Dokümantasyon
│   │   ├── 📄 ARCHITECTURE.md             # Protokol mimarisi (Teknik referans)
│   │   ├── 📄 API_DOCUMENTATION.md        # Backend API endpoint referansı
│   │   ├── 📄 LOCAL_DEVELOPMENT.md        # Yerel geliştirme kurulum rehberi
│   │   ├── 📄 GAME_THEORY.md              # Oyun teorisi ve Bleeding Escrow akışı
│   │   └── 📄 UX_FLOW.md                  # Kullanıcı deneyimi ve akış şemaları
│   │
│   ├── 📁 en/                             # English Documentation
│   │   ├── 📄 ARCHITECTURE.md             # Protocol architecture
│   │   ├── 📄 API_DOCUMENTATION.md        # Backend API endpoint reference
│   │   ├── 📄 LOCAL_DEVELOPMENT.md        # Local setup guide
│   │   ├── 📄 GAME_THEORY.md              # Game theory & Bleeding Escrow logic
│   │   └── 📄 UX_FLOW.md                  # UX flow and diagrams
```

---

## Dosya Sayıları

| Katman | Dosya Sayısı |
|--------|-------------|
| Kontrat (`contracts/`) | 5 |
| Backend (`backend/scripts/`) | 18 |
| Frontend (`frontend/src/`) | 9 |
| Dokümantasyon (`docs/`) | 14 |
| **Toplam** | **~46** |

---

## Kritik Dosyalar (Dokunmadan Önce Düşün)

| Dosya | Neden Kritik |
|-------|-------------|
| `contracts/src/ArafEscrow.sol` | Ana kontrat — deploy sonrası değiştirilemez |
| `backend/scripts/services/encryption.js` | Master key yönetimi — yanlış değişiklik PII veri kaybına yol açar |
| `backend/scripts/services/eventListener.js` | On-chain senkronizasyon — FIFO sırası bozulursa state tutarsızlığı |
| `frontend/src/hooks/useArafContract.js` | Tüm kontrat etkileşimleri — ABI uyumsuzluğu tüm tx'leri kırar |
| `backend/scripts/services/siwe.js` | JWT gizliliği — entropy kontrolü başlangıçta çalışır |
