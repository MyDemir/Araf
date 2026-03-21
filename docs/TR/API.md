# 🌀 Araf Protocol: API Dökumani

> **Versiyon:** 2.0 | **Base URL:** `/api` | **Son Güncelleme:** Mart 2026

Bu doküman, Araf Protokolü'nün backend API endpoint'leri için detaylı bir referans sunar.

---

## Kimlik Doğrulama (Authentication)

API, güvenlik için iki katmanlı bir token sistemi kullanır:

1.  **Auth JWT (JSON Web Token):** SIWE (Sign-In with Ethereum) akışı ile elde edilen, kısa ömürlü (15 dk) bir token. **AUDIT FIX F-01:** JWT artık `araf_jwt` adlı `httpOnly + Secure + SameSite=Strict` cookie olarak set edilir. JavaScript tarafından erişilemez (XSS koruması). Sonraki isteklerde `credentials: 'include'` ile otomatik gönderilir.
2.  **Refresh Token:** JWT süresi dolduğunda yeni token çifti almak için kullanılan, 7 günlük `araf_refresh` cookie'si. Sadece `/api/auth/*` endpoint'lerine gönderilir (`path: /api/auth`).
3.  **PII Token:** IBAN gibi hassas PII verilerine erişmek için özel olarak gereken, daha da kısa ömürlü (15 dk) ve işlem bazlı (trade-scoped) bir token. Bu token `Authorization: Bearer <piiToken>` header'ı ile gönderilir (cookie değil).

### Auth Akışı (SIWE + Cookie)

1.  `GET /auth/nonce?wallet=<address>`: Tek kullanımlık, benzersiz bir nonce alın.
2.  **Client-Side:** Alınan nonce ile EIP-4361 mesajını imzalayın.
3.  `POST /auth/verify`: Mesajı ve imzayı göndererek JWT ve Refresh Token'ı **httpOnly cookie** olarak alın.
4.  **Sonraki İstekler:** `credentials: 'include'` ile istek gönderin — cookie otomatik eklenir, manuel Authorization header'a gerek yoktur.
5.  `GET /api/auth/me`: Sayfa yüklendiğinde cookie'nin geçerli olup olmadığını kontrol eder (httpOnly cookie JS'ten okunamadığından bu endpoint gereklidir).
6.  `POST /auth/refresh`: JWT'nin süresi dolduğunda (401 yanıtında), yeni token çifti almak için çağrılır. Refresh token cookie'den otomatik okunur.

---

## Endpoints

### Auth Rotaları (`/api/auth`)

#### `GET /auth/nonce`
* **Açıklama:** SIWE imza süreci için tek kullanımlık bir nonce üretir. Redis'te 5 dakika TTL ile saklanır.
* **Yetkilendirme:** Herkese Açık
* **Query Parametreleri:** `wallet` (kullanıcının Ethereum cüzdan adresi)
* **Başarılı Yanıt (200 OK):**
```json
{
  "nonce": "a1b2c3d4e5f6...",
  "siweDomain": "araf.protocol"
}
```

#### `POST /auth/verify`
* **Açıklama:** SIWE imzasını doğrular ve geçerliyse JWT + Refresh Token'ı **httpOnly cookie** olarak set eder.
* **Yetkilendirme:** Herkese Açık
* **İstek Body:**
```json
{
  "message": "EIP-4361 formatında tam SIWE mesajı",
  "signature": "0x..."
}
```
* **Başarılı Yanıt (200 OK):**
```json
{
  "wallet": "0x...",
  "profile": { "wallet_address": "0x...", "reputation_cache": { ... }, "is_banned": false }
}
```
> **AUDIT FIX F-01:** Token'lar response body'de **döndürülmez**. `araf_jwt` (15 dk) ve `araf_refresh` (7 gün, path: /api/auth) httpOnly cookie olarak set edilir. JavaScript'ten erişilemez.

#### `GET /auth/me`
* **Açıklama:** Cookie'deki JWT geçerliyse oturum bilgisini döndürür. Frontend sayfa yüklendiğinde `isAuthenticated` durumunu belirlemek için kullanır. httpOnly cookie JS'ten okunamadığından bu endpoint zorunludur.
* **Yetkilendirme:** Auth JWT Cookie (`araf_jwt`)
* **Başarılı Yanıt (200 OK):**
```json
{ "wallet": "0x...", "authenticated": true }
```
* **Hata Yanıtı (401):** Cookie yoksa veya süresi dolmuşsa.

#### `POST /auth/refresh`
* **Açıklama:** Süresi dolmuş bir JWT'yi yenilemek için kullanılır. Refresh token `araf_refresh` cookie'sinden otomatik okunur.
* **Yetkilendirme:** Refresh Token Cookie (`araf_refresh`)
* **İstek Body:**
```json
{
  "wallet": "0x..."
}
```
> **AUDIT FIX F-01:** `refreshToken` alanı body'den kaldırıldı. Cookie'den otomatik okunur.
* **Başarılı Yanıt (200 OK):**
```json
{ "wallet": "0x..." }
```
> Yeni `araf_jwt` ve `araf_refresh` cookie'leri set edilir. Token'lar body'de döndürülmez.

#### `POST /auth/logout`
* **Açıklama:** Oturumu kapatır. Redis'teki refresh token aile kayıtlarını siler, cookie'leri temizler.
* **Yetkilendirme:** Auth JWT Cookie
* **Başarılı Yanıt (200 OK):**
```json
{ "success": true, "message": "Oturum kapatıldı." }
```

#### `PUT /auth/profile`
* **Açıklama:** Kullanıcının banka hesabı sahibi, IBAN ve Telegram bilgisini günceller. Veriler veritabanına yazılmadan önce AES-256-GCM ile şifrelenir.
* **Yetkilendirme:** Auth JWT Cookie
* **İstek Body:**
```json
{
  "bankOwner": "Adınız Soyadınız",
  "iban": "TR...",
  "telegram": "kullanici_adiniz"
}
```
* **Başarılı Yanıt (200 OK):**
```json
{ "success": true, "message": "Profil bilgilerin güncellendi." }
```

---

### İlan Rotaları (`/api/listings`)

#### `GET /api/listings`
* **Açıklama:** Pazar yerindeki açık ilanları listeler. Filtreleme ve sayfalama destekler.
* **Yetkilendirme:** Herkese Açık
* **Query Parametreleri:** `fiat`, `amount`, `tier`, `page`, `limit`
* **Başarılı Yanıt (200 OK):**
```json
{
  "listings": [ { "_id": "...", "maker_address": "...", "crypto_asset": "USDT", "fiat_currency": "TRY", "exchange_rate": 33.5, "limits": { "min": 500, "max": 2500 }, "tier_rules": { "required_tier": 1, "maker_bond_pct": 8, "taker_bond_pct": 10 }, "status": "OPEN" } ],
  "total": 15,
  "page": 1,
  "limit": 20
}
```

#### `POST /api/listings`
* **Açıklama:** Yeni bir P2P ilanı oluşturur. Maker'ın on-chain tier'ı kontrol edilir.
* **Yetkilendirme:** Auth JWT Cookie
* **İstek Body:**
```json
{
  "crypto_asset": "USDT",
  "fiat_currency": "TRY",
  "exchange_rate": 33.50,
  "limits": { "min": 500, "max": 2500 },
  "tier": 1,
  "token_address": "0x..."
}
```
> **Not:** `tier_rules` değil, düz `tier` alanı gönderilmeli. `token_address` zorunludur.
* **Başarılı Yanıt (201 Created):** Oluşturulan ilanın tam nesnesini döndürür.

#### `DELETE /api/listings/:id`
* **Açıklama:** Bir ilanı pazar yerinden kaldırır (soft delete). On-chain escrow iptali ayrıca `cancelOpenEscrow()` kontrat fonksiyonu ile yapılır.
* **Yetkilendirme:** Auth JWT Cookie (Sadece ilan sahibi silebilir)
* **Başarılı Yanıt (200 OK):**
```json
{ "success": true }
```
* **Hata Yanıtları:** `403 Forbidden` (ilan sahibi değilse), `409 Conflict` (ilana bağlı aktif bir işlem varsa).

---

### İşlem Rotaları (`/api/trades`)

#### `GET /api/trades/my`
* **Açıklama:** Kullanıcının aktif (çözülmemiş) işlemlerini listeler.
* **Yetkilendirme:** Auth JWT Cookie
* **Başarılı Yanıt (200 OK):** `{ "trades": [ ... ] }`

#### `GET /api/trades/history`
* **Açıklama:** Kullanıcının tamamlanmış işlem geçmişini listeler (RESOLVED, CANCELED, BURNED).
* **Yetkilendirme:** Auth JWT Cookie
* **Query Parametreleri:** `page`, `limit`
* **Başarılı Yanıt (200 OK):** `{ "trades": [ ... ], "total": 5, "page": 1, "limit": 10 }`

#### `GET /api/trades/by-escrow/:onchainId`
* **Açıklama:** On-chain escrow ID'ye göre Trade belgesini döndürür. Frontend'de Listing._id yerine Trade._id'ye ulaşmak için kullanılır. Sadece işlemin tarafları erişebilir.
* **Yetkilendirme:** Auth JWT Cookie
* **Başarılı Yanıt (200 OK):**
```json
{ "trade": { "_id": "...", "onchain_escrow_id": 42, "maker_address": "0x...", "taker_address": "0x...", "status": "LOCKED" } }
```

#### `POST /api/trades/propose-cancel`
* **Açıklama:** EIP-712 imzasını kaydeder. Her iki taraf imzaladığında `bothSigned: true` döner ve on-chain gönderim için hazır olur.
* **Yetkilendirme:** Auth JWT Cookie
* **İstek Body:**
```json
{
  "tradeId": "mongodb_objectid",
  "signature": "0x...",
  "deadline": 1735000000
}
```
* **Başarılı Yanıt (200 OK):**
```json
{ "success": true, "bothSigned": false, "message": "Teklifin kaydedildi. Karşı tarafın imzası bekleniyor." }
```

#### `POST /api/trades/:id/chargeback-ack`
* **Açıklama:** Maker'ın, fonları serbest bırakmadan önce "Ters İbraz" riskini anladığını yasal kayıt olarak kaydeder. IP hash'i (SHA-256) saklanır, ham IP asla saklanmaz (GDPR uyumlu).
* **Yetkilendirme:** Auth JWT Cookie (Sadece Maker çağırabilir)
* **Durum Koşulu:** Trade `PAID` veya `CHALLENGED` olmalı
* **Başarılı Yanıt (201 Created):**
```json
{ "success": true, "acknowledged_at": "2026-03-19T10:00:00.000Z" }
```

---

### PII Rotaları (`/api/pii`)

Bu rotalar, en yüksek güvenlik seviyesine sahip endpoint'lerdir. Rate limit: 3 istek / 10 dakika (IP + wallet başına).

#### `POST /api/pii/request-token/:tradeId`
* **Açıklama:** **Adım 1:** IBAN verisine erişmek için kısa ömürlü (15 dk), işlem bazlı bir PII token talep eder.
* **Yetkilendirme:** Auth JWT Cookie (Sadece işlemin Taker'ı çağırabilir)
* **Durum Koşulu:** Trade `LOCKED`, `PAID` veya `CHALLENGED` olmalı
* **Başarılı Yanıt (200 OK):**
```json
{ "piiToken": "ey..." }
```

#### `GET /api/pii/:tradeId`
* **Açıklama:** **Adım 2:** Kısa ömürlü PII token ile satıcının şifresi çözülmüş banka bilgilerini döndürür. Yanıt loglanmaz, önbelleğe alınmaz.
* **Yetkilendirme:** `Authorization: Bearer <piiToken>` header'ı (cookie değil — trade-scoped ve kısa ömürlü)
* **Başarılı Yanıt (200 OK):**
```json
{
  "bankOwner": "Ahmet Yılmaz",
  "iban": "TR330006100519786457841326",
  "telegram": "ahmet_tr",
  "notice": "This information is end-to-end encrypted. It is not stored on-chain or in logs."
}
```

---

### Diğer Rotalar

#### `GET /api/stats`
* **Açıklama:** Protokolün genel istatistiklerini döndürür. Redis'te 1 saat önbelleklenir.
* **Yetkilendirme:** Herkese Açık
* **Başarılı Yanıt (200 OK):**
```json
{
  "stats": {
    "total_volume_usdt": 123456.78,
    "completed_trades": 892,
    "active_listings": 34,
    "burned_bonds_usdt": 450.20,
    "avg_trade_hours": 2.4,
    "changes_30d": { "total_volume_usdt_pct": 12.5, "completed_trades_pct": 8.3 }
  }
}
```

#### `POST /api/feedback`
* **Açıklama:** Kullanıcı geri bildirimi gönderir. Saatte en fazla 3 istek.
* **Yetkilendirme:** Auth JWT Cookie
* **İstek Body:**
```json
{
  "rating": 5,
  "comment": "Harika bir platform!",
  "category": "suggestion"
}
```
> `category` zorunludur: `"bug"`, `"suggestion"`, `"ui/ux"`, `"other"`
* **Başarılı Yanıt (201 Created):** `{ "success": true }`

#### `GET /health`
* **Açıklama:** Backend ve event listener'ın sağlık durumunu döndürür. Fly.io health check tarafından kullanılır.
* **Yetkilendirme:** Herkese Açık
* **Başarılı Yanıt (200 OK):**
```json
{ "status": "ok", "worker": "active", "timestamp": "2026-03-19T10:00:00.000Z" }
```
