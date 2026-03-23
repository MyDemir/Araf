# ⏳ Araf Protocol / P2P Escrow
**"Trust the Time, Not the Oracle. / Zamana Güven, Hakeme Değil."**

[![Version: 2.0](https://img.shields.io/badge/Version-2.0-blue.svg)]()
[![Network: Base L2](https://img.shields.io/badge/Network-Base-blueviolet.svg)]()
[![Architecture: Web 2.5](https://img.shields.io/badge/Architecture-Web_2.5-orange.svg)]()

---

## 🌍 Language / Dil Selection
* [English Version](#-english-version)
* [Türkçe Versiyon](#-türkçe-versiyon)

---

## 🇬🇧 English Version

Araf Protocol is a **non-custodial**, **humanless**, and **oracle-free** peer-to-peer (P2P) escrow system between fiat currencies and crypto assets (USDT, USDC).

Traditional P2P platforms rely on human moderators and subjective decisions. Araf eliminates intermediaries with uncompromising mathematics and time-based economic game theory.

### 🏗 Why Web 2.5?
Araf operates as a **Web 2.5 Hybrid System**, combining blockchain security with the performance and privacy of modern web standards.

| Layer | Function | Technology | Rationale |
| :--- | :--- | :--- | :--- |
| **Web3 (On-Chain)** | Asset Security & Dispute | Solidity (Base L2) | Funds are never held by a central entity. Bleeding Escrow timers are immutable. |
| **Web2 (Off-Chain)** | Privacy & Performance | Node.js, MongoDB, Redis | PII data (IBAN) is not stored on-chain for GDPR compliance. Sub-50ms listing queries. |

### ⚡ Key Engineering Solutions
* **🔐 Zero Private Key Backend:** The server acts only as a "Relayer" and has no keys to move user funds.
* **🛡 Anti-Sybil Shield:** Filters like Wallet Age (min. 7 days), Dust limits, and cooldowns prevent bot attacks.
* **🔒 Envelope Encryption:** Sensitive data is encrypted with AES-256-GCM; even a DB leak won't expose PII.
* **🤝 Gasless Agreement (EIP-712):** Mutual decisions like cancellations are signed off-chain without gas fees.
* **⚠️ Triangulation Fraud Prevention:** Makers are shown the Taker's decrypted real name to verify the sender's identity.

### 🌊 Standard Transaction Flow
1. **Create:** Maker locks funds and collateral (`OPEN`).
2. **Lock:** Taker locks collateral after Anti-Sybil check (`LOCKED`).
3. **Pay:** Taker reports payment with IPFS receipt (`PAID`).
4. **Release:** Maker confirms and funds are distributed (`RESOLVED`).

---

## 🇹🇷 Türkçe Versiyon

Araf Protokolü; fiat para birimleri ile kripto varlıklar (USDT, USDC) arasında, **emanet tutmayan (non-custodial)**, **insansız** ve **oracle-bağımsız** bir eşten eşe (P2P) takas protokolüdür.

Geleneksel P2P platformlarının aksine Araf, uyuşmazlıkları çözmek için moderatörlere güvenmez; bunun yerine dürüstsüzlüğü pahalıya mal eden on-chain zamanlayıcıları kullanır.

### 🏗 Neden Web 2.5?
Araf, blokzincirin tavizsiz güvenliğini modern webin kullanıcı deneyimi ve gizlilik standartlarıyla birleştirir.

| Katman | İşlev | Teknoloji | Gerekçe |
| :--- | :--- | :--- | :--- |
| **Web3 (On-Chain)** | Fon Güvenliği & Hakemlik | Solidity (Base L2) | Fonlar asla merkezi bir cüzdanda toplanmaz. Bleeding Escrow zamanlayıcıları değiştirilemez. |
| **Web2 (Off-Chain)** | Gizlilik & Performans | Node.js, MongoDB, Redis | IBAN verileri KVKK/GDPR gereği on-chain'e yazılmaz. İlanlar 50ms altında sorgulanır. |

### ⚡ Öne Çıkan Mühendislik Çözümleri
* **🔐 Sıfır Özel Anahtar (Zero-PK) Backend:** Sunucumuz sadece bir "Relayer"dır. Fonları hareket ettirecek anahtarlara sahip değildir.
* **🛡 Anti-Sybil Kalkanı:** Cüzdan yaşı (min. 7 gün), Dust limiti ve cooldown filtreleri ile bot saldırıları engellenir.
* **🔒 Zarf Şifreleme (Envelope Encryption):** Hassas veriler AES-256-GCM ile şifrelenir. Master Key sadece KMS ortamında yaşar.
* **🤝 Gassız Uzlaşma (EIP-712):** İptal gibi ortak kararlar off-chain imzalanarak gassız ve cezasız gerçekleştirilir.
* **⚠️ Üçgen Dolandırıcılık Koruması:** Satıcıya, alıcının şifresi çözülmüş gerçek adı gösterilerek kimlik doğrulaması zorunlu kılınır.

### 🌊 Standart İşlem Akışı
1. **Create:** Maker fonları ve teminatı kilitler (`OPEN`).
2. **Lock:** Taker teminatını kilitler (`LOCKED`).
3. **Pay:** Taker ödemeyi bildirir ve kanıtını sunar (`PAID`).
4. **Release:** Maker onaylar ve fonlar dağıtılır (`RESOLVED`).

---

## 📖 Documentation / Dokümantasyon
* **Canonical Architecture / Kanonik Mimari:** [English Version (EN)](./docs/EN/ARCHITECTURE.md) | [Türkçe Versiyon (TR)](./docs/TR/ARCHITECTURE.md)
* **API Reference / API Referansı:** [Documentation](./docs/EN/API.md)
* **Game Theory / Oyun Teorisi:** [Flowcharts & Logic](./docs/EN/GAME_THEORY.md)
* **Project Structure / Dosya Yapısı:** [Directory Guide](./docs/EN/ux.md)

---
*Araf Protocol — "The system doesn't judge. It makes dishonesty expensive."*
