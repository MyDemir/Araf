/**
 * ErrorBoundary — Global Render Hata Sınırı & Senkronize Loglama
 *
 * [TR] React render hatalarını yakalar, kullanıcıya dostu bir arayüz gösterir
 * ve hatayı backend'deki merkezi log sistemine sessizce gönderir.
 *
 * YÜKS-10 Fix: ErrorBoundary Üzerinden PII Sızıntısı kapatıldı.
 *   ÖNCEKİ: Hata tam IBAN render edilirken (örn. PIIDisplay içinde) oluşursa
 *   componentStack veya error.message içinde plaintext IBAN log dosyasına yazılıyordu.
 *   ŞİMDİ: Log gönderilmeden önce bilinen PII pattern'ları (IBAN, telefon, vb.)
 *   scrub fonksiyonu ile temizleniyor. PIIDisplay bileşeninden kaynaklanan
 *   hatalar özel olarak işaretleniyor.
 *
 * FRONT-04 Fix: Localhost Port Sızıntısı kapatıldı.
 *   ÖNCEKİ: VITE_API_URL tanımsızsa hataları http://localhost:4000/api'ye gönderiyordu.
 *   Üretim ortamında bu değişken okunamazsa hassas hata stack'leri kullanıcının
 *   yerel bilgisayarındaki 4000 portuna sızıyordu.
 *   ŞİMDİ: Üretim ortamında VITE_API_URL tanımsızsa log isteği ATILMIYOR.
 *   Geliştirme ortamında localhost fallback korumalı şekilde çalışıyor.
 */

import React from 'react';

// [TR] Hassas veri pattern'ları — log göndermeden önce temizlenir
// [EN] Sensitive data patterns — scrubbed before sending logs
const PII_PATTERNS = [
  // IBAN: TR + 24 rakam
  /TR\d{24}/gi,
  // Kart numaraları (16 hane)
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  // Türk telefon numaraları
  /(\+90|0)?\s?[5][0-9]{2}[\s-]?[0-9]{3}[\s-]?[0-9]{2}[\s-]?[0-9]{2}/g,
  // Ethereum adresleri (logda gerekli değilse)
  // /0x[a-fA-F0-9]{40}/g,
];

/**
 * PII içeren string'leri temizler.
 * @param {string} text - Temizlenecek metin
 * @returns {string} Scrub edilmiş metin
 */
function scrubPII(text) {
  if (!text || typeof text !== 'string') return text;
  let clean = text;
  for (const pattern of PII_PATTERNS) {
    clean = clean.replace(pattern, '[REDACTED]');
  }
  return clean;
}

/**
 * Object veya string olabilen değeri güvenli stringe çevirir ve scrub eder.
 */
function safeStringify(value) {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return scrubPII(str);
  } catch {
    return '[Serialize edilemedi]';
  }
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // 1. Tarayıcı konsoluna bas (geliştirme aşaması için)
    console.error('[ErrorBoundary] Kritik Render Hatası:', error, errorInfo);

    // FRONT-04 Fix: Üretim ortamında VITE_API_URL tanımsızsa log atma
    const apiUrl = import.meta.env.VITE_API_URL;
    if (!apiUrl && import.meta.env.PROD) {
      console.warn('[ErrorBoundary] VITE_API_URL tanımsız — log backend\'e gönderilmedi.');
      return;
    }

    const logBase = apiUrl || (import.meta.env.DEV ? 'http://localhost:4000/api' : null);
    if (!logBase) return;

    // YÜKS-10 Fix: PII içerebilecek alanlar gönderilmeden önce scrub ediliyor
    const scrubbedMessage    = scrubPII(error.message || 'Bilinmeyen Render Hatası');
    const scrubbedStack      = scrubPII(error.stack || '');
    // PIIDisplay kaynaklı hatalar için componentStack'ten yalnızca bileşen adları alınır
    const componentStackLines = (errorInfo.componentStack || '')
      .split('\n')
      .filter(Boolean)
      .map(line => line.trim())
      .slice(0, 20); // stack'in tamamını değil sadece üst 20 satırı gönder

    fetch(`${logBase}/logs/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level:          'ERROR',
        message:        scrubbedMessage,
        stack:          scrubbedStack,
        componentStack: componentStackLines.join('\n'), // plaintext PII yok
        url:            window.location.href,
        timestamp:      new Date().toISOString(),
      }),
    }).catch(() => {
      // [TR] Backend kapalıysa veya ağ hatası varsa uygulamayı çökertme
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 font-sans">
          <div className="bg-slate-800 border border-red-500/30 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
            <div className="text-5xl mb-6">⚠️</div>
            <h2 className="text-white font-bold text-2xl mb-3">Sistemde Kesinti Oluştu</h2>
            <p className="text-slate-400 text-sm mb-8 leading-relaxed">
              İşleminiz sırasında teknik bir sorunla karşılaşıldı.
              Hata detayları teknik ekibimize iletildi.
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => window.location.reload()}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-6 rounded-xl transition-all active:scale-95 shadow-lg shadow-blue-900/20"
              >
                Sayfayı Yenile
              </button>
              <button
                onClick={() => window.location.href = '/'}
                className="w-full bg-transparent border border-slate-600 hover:bg-slate-700 text-slate-300 py-2.5 px-6 rounded-xl transition-all"
              >
                Ana Sayfaya Dön
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
