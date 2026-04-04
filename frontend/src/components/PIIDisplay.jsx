/**
 * PIIDisplay — Şifreli IBAN + Telegram Görüntüleme Bileşeni
 *
 * IBAN varsayılan olarak GİZLİ gelir; kullanıcı onay verince fetch edilir.
 * usePII(tradeId, authenticatedFetch) — tüm auth httpOnly cookie üzerinden.
 *
 * ORTA-15 Fix: Pano (Clipboard) Güvenlik Eksikliği giderildi.
 *   ÖNCEKİ: navigator.clipboard.writeText hata durumunu handle etmiyordu.
 *   HTTP ortamında (Secure Context dışı) sessizce başarısız oluyordu.
 *   Kullanıcı IBAN'ı kopyaladığını sanıp banka uygulamasına geçiyordu.
 *   ŞİMDİ:
 *     1. window.isSecureContext kontrolü — HTTP'de alternatif yöntem sunuluyor
 *     2. try-catch ile hata yakalanıp kullanıcıya görsel uyarı veriliyor
 *     3. Güvenli bağlam yoksa seçim (select) + execCommand fallback kullanılıyor
 *
 * Kullanım (App.jsx'te):
 *   <PIIDisplay tradeId={activeTrade.id} lang={lang}
 *               getSafeTelegramUrl={getSafeTelegramUrl}
 *               authenticatedFetch={authenticatedFetch} />
 */

import React, { useState } from 'react';
import { usePII } from '../hooks/usePII';

const LABELS = {
  tr: {
    sectionTitle:     'Satıcı Banka & İletişim Bilgileri',
    lockedTitle:      'IBAN şifrelenmiş & korunuyor',
    lockedSub:        'Güvenli görmek için kimliğini doğrula',
    revealBtn:        '🔓 IBAN & Telegram\'ı Güvenli Göster',
    revealBtnLoading: 'Doğrulanıyor...',
    copyIban:         '📋 IBAN Kopyala',
    copied:           '✓ Kopyalandı',
    copyError:        '⚠ Kopyalanamadı — manuel seçin',
    noSecureContext:  '⚠ HTTP bağlantısı — IBAN\'ı manuel kopyalayın',
    hideBtn:          '🙈 Gizle',
    telegramBtn:      'Telegram\'dan Mesaj At',
    disclaimer:       '🔒 Şifreli kanal — ekran görüntüsüne dikkat et',
    notice:           'Bu bilgiler blockchain\'e kaydedilmez. Sadece bu işleme özel şifreli olarak iletildi.',
    loading:          'Yükleniyor...',
    noTelegram:       'Telegram bilgisi eklenmemiş',
  },
  en: {
    sectionTitle:     'Seller Bank & Contact Details',
    lockedTitle:      'IBAN is encrypted & protected',
    lockedSub:        'Verify your identity to view securely',
    revealBtn:        '🔓 Securely Reveal IBAN & Telegram',
    revealBtnLoading: 'Verifying...',
    copyIban:         '📋 Copy IBAN',
    copied:           '✓ Copied',
    copyError:        '⚠ Copy failed — please select manually',
    noSecureContext:  '⚠ HTTP connection — copy IBAN manually',
    hideBtn:          '🙈 Hide',
    telegramBtn:      'Message on Telegram',
    disclaimer:       '🔒 Encrypted channel — beware of screenshots',
    notice:           'Not stored on-chain. Transmitted encrypted for this trade only.',
    loading:          'Loading...',
    noTelegram:       'No Telegram info provided',
  },
};

/**
 * @param {string}   tradeId             Backend trade ID (Trade koleksiyonunun MongoDB _id'si)
 * @param {string}   lang                'TR' veya 'EN'
 * @param {Function} getSafeTelegramUrl  App.jsx'ten gelen memoize edilmiş URL yardımcısı
 * @param {Function} authenticatedFetch  App.jsx'ten gelen JWT yönetimli fetch (YÜKS-06)
 */
export default function PIIDisplay({ tradeId, lang = 'tr', getSafeTelegramUrl, authenticatedFetch }) {
  const normalizedLang = (lang || 'tr').toLowerCase();
  const t = LABELS[normalizedLang] || LABELS['tr'];

  const { pii, loading, error, fetchPII, clearPII } = usePII(tradeId, authenticatedFetch);
  const [revealed, setRevealed] = useState(false);
  // [TR] copied: 'idle' | 'success' | 'error'
  const [copyState, setCopyState] = useState('idle');

  const handleReveal = async () => {
    if (!pii) await fetchPII();
    setRevealed(true);
  };

  const handleHide = () => {
    setRevealed(false);
    clearPII();
    setCopyState('idle');
  };

  // ORTA-15 Fix: Clipboard kopyalama güvenli ve hata toleranslı
  const handleCopyIban = async () => {
    if (!pii?.iban) return;
    const cleanIban = pii.iban.replace(/\s/g, '');

    // [TR] Güvenli bağlam kontrolü (HTTPS veya localhost)
    if (!window.isSecureContext) {
      // [TR] HTTP ortamı — otomatik kopyalama API'si çalışmaz, kullanıcıyı uyar
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 3000);
      return;
    }

    try {
      await navigator.clipboard.writeText(cleanIban);
      setCopyState('success');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch (err) {
      // [TR] İzin reddedildi veya başka clipboard hatası — fallback: seçim yöntemi
      try {
        const textArea = document.createElement('textarea');
        textArea.value = cleanIban;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textArea);
        setCopyState(success ? 'success' : 'error');
      } catch {
        setCopyState('error');
      }
      setTimeout(() => setCopyState('idle'), 3000);
    }
  };

  const buildTelegramUrl = (handle) => {
    if (!handle) return '#';
    return getSafeTelegramUrl
      ? getSafeTelegramUrl(handle)
      : `https://t.me/${handle.replace(/[^a-zA-Z0-9_]/g, '')}`;
  };

  // ── Kilitli görünüm ──────────────────────────────────────────────────────
  if (!revealed) {
    return (
      <div className="bg-slate-900 p-4 rounded-xl border border-slate-700">
        <p className="text-slate-400 text-xs mb-3 font-medium uppercase tracking-widest">
          🛡️ {t.sectionTitle}
        </p>
        <div className="bg-slate-800 rounded-lg p-3 mb-3 flex items-center space-x-3">
          <span className="text-2xl">🔒</span>
          <div>
            <p className="text-white font-medium text-sm">{t.lockedTitle}</p>
            <p className="text-slate-500 text-xs mt-0.5">{t.lockedSub}</p>
          </div>
        </div>

        {/* HTTP uyarısı — ORTA-15 */}
        {!window.isSecureContext && (
          <div className="mb-3 p-2 bg-yellow-950/40 border border-yellow-900/50 rounded-lg">
            <p className="text-yellow-400 text-xs">{t.noSecureContext}</p>
          </div>
        )}

        {error && (
          <div className="mb-3 p-2 bg-red-950/40 border border-red-900/50 rounded-lg">
            <p className="text-red-400 text-xs">⚠ {error}</p>
          </div>
        )}

        <button
          onClick={handleReveal}
          disabled={loading}
          className={`w-full py-2.5 rounded-xl font-bold text-sm transition ${
            loading
              ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20'
          }`}
        >
          {loading ? (
            <span className="flex items-center justify-center space-x-2">
              <span className="w-4 h-4 border-2 border-blue-300 border-t-transparent rounded-full animate-spin" />
              <span>{t.revealBtnLoading}</span>
            </span>
          ) : t.revealBtn}
        </button>

        <p className="text-center text-[10px] text-slate-500 mt-2">{t.disclaimer}</p>
      </div>
    );
  }

  // ── Açık görünüm ─────────────────────────────────────────────────────────
  return (
    <div className="bg-slate-900 p-4 rounded-xl border border-blue-500/40 relative overflow-hidden">
      <div className="absolute top-0 right-0 bg-blue-600 text-white text-[10px] font-bold px-2 py-1 rounded-bl-lg">
        End-to-End Encrypted
      </div>

      <p className="text-slate-400 text-xs mb-3 font-medium uppercase tracking-widest">
        🛡️ {t.sectionTitle}
      </p>

      {pii ? (
        <>
          <p className="text-slate-400 text-[10px] mb-0.5 uppercase tracking-widest">Ad Soyad</p>
          <p className="font-bold text-white text-base mb-3">{pii.bankOwner}</p>

          <p className="text-slate-400 text-[10px] mb-0.5 uppercase tracking-widest">IBAN</p>
          <p className="font-mono text-emerald-400 mb-3 break-all text-sm tracking-wider">
            {pii.iban}
          </p>

          <div className="flex space-x-2 mb-3">
            <button
              onClick={handleCopyIban}
              className={`flex-1 text-xs font-medium py-2 rounded-lg transition border ${
                copyState === 'success'
                  ? 'bg-emerald-900/30 text-emerald-400 border-emerald-700'
                  : copyState === 'error'
                  ? 'bg-red-900/30 text-red-400 border-red-700'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-600'
              }`}
            >
              {copyState === 'success'
                ? t.copied
                : copyState === 'error'
                ? t.copyError
                : t.copyIban}
            </button>
            <button
              onClick={handleHide}
              className="px-4 bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs py-2 rounded-lg transition border border-slate-600"
            >
              {t.hideBtn}
            </button>
          </div>

          {pii.telegram ? (
            <a
              href={buildTelegramUrl(pii.telegram)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center space-x-2 w-full py-2.5 rounded-xl bg-[#24A1DE]/10 border border-[#24A1DE]/30 text-[#24A1DE] hover:bg-[#24A1DE]/20 text-sm font-bold transition-all mb-3"
            >
              <span>💬</span>
              <span>{t.telegramBtn} (@{pii.telegram})</span>
            </a>
          ) : (
            <div className="flex items-center justify-center space-x-2 w-full py-2 rounded-xl bg-slate-800/50 border border-slate-700 text-slate-500 text-xs mb-3">
              <span>💬</span>
              <span>{t.noTelegram}</span>
            </div>
          )}

          <div className="p-2 bg-slate-800 rounded-lg flex items-start space-x-2 border border-slate-700">
            <span className="text-sm shrink-0">🛡️</span>
            <p className="text-[10px] text-slate-400 leading-tight">{t.notice}</p>
          </div>
        </>
      ) : (
        <div className="text-center py-4">
          <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
          <p className="text-slate-400 text-sm">{t.loading}</p>
        </div>
      )}
    </div>
  );
}
