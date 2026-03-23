/**
 * PIIDisplay — Şifreli IBAN + Telegram Görüntüleme Bileşeni
 *
 *
 *. IBAN varsayılan olarak GİZLİ gelir; kullanıcı onay verince fetch edilir
 *  usePII(tradeId) — tüm auth httpOnly cookie üzerinden yürütülür (credentials: include).
 *
 * Kullanım (App.jsx'te):
 *   <PIIDisplay tradeId={activeTrade.id} lang={lang} getSafeTelegramUrl={getSafeTelegramUrl} />
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
    hideBtn:          '🙈 Gizle',
    telegramBtn:      'Telegram\'dan Mesaj At',
    disclaimer:       '🔒 Şifreli kanal — ekran görüntüsüne dikkat et',
    notice:           'Bu bilgiler blockchain\'e kaydedilmez. Sadece bu işleme özel şifreli olarak iletildi. İşlem tamamlandıktan sonra kaydetme.',
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
    hideBtn:          '🙈 Hide',
    telegramBtn:      'Message on Telegram',
    disclaimer:       '🔒 Encrypted channel — beware of screenshots',
    notice:           'This information is not stored on-chain. Transmitted encrypted for this trade only. Do not save after completion.',
    loading:          'Loading...',
    noTelegram:       'No Telegram info provided',
  },
};

/**
 * @param {string}   tradeId          Backend trade ID (Trade koleksiyonunun MongoDB _id'si)
 * @param {string}   lang             'TR' veya 'EN' (büyük/küçük harf fark etmez)
 * @param {Function} getSafeTelegramUrl  App.jsx'ten gelen memoize edilmiş güvenli URL yardımcısı
 */
export default function PIIDisplay({ tradeId, lang = 'tr', getSafeTelegramUrl }) {
  const normalizedLang = (lang || 'tr').toLowerCase();
  const t = LABELS[normalizedLang] || LABELS['tr'];

  const { pii, loading, error, fetchPII, clearPII } = usePII(tradeId);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied]     = useState(false);

  const handleReveal = async () => {
    if (!pii) await fetchPII();
    setRevealed(true);
  };

  const handleHide = () => {
    setRevealed(false);
    clearPII();
  };

  const handleCopyIban = () => {
    if (!pii?.iban) return;
    navigator.clipboard.writeText(pii.iban.replace(/\s/g, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const buildTelegramUrl = (handle) => {
    if (!handle) return '#';
    return getSafeTelegramUrl ? getSafeTelegramUrl(handle) : `https://t.me/${handle.replace(/[^a-zA-Z0-9_]/g, '')}`;
  };

  // ── Henüz açılmamış (kilitli) görünüm ────────────────────────────────────
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
              <span className="w-4 h-4 border-2 border-blue-300 border-t-transparent rounded-full animate-spin"></span>
              <span>{t.revealBtnLoading}</span>
            </span>
          ) : (
            t.revealBtn
          )}
        </button>

        <p className="text-center text-[10px] text-slate-500 mt-2">{t.disclaimer}</p>
      </div>
    );
  }

  // ── Açılmış (revealed) görünüm ────────────────────────────────────────────
  return (
    <div className="bg-slate-900 p-4 rounded-xl border border-blue-500/40 relative overflow-hidden">
      {/* Şifreli kanal rozeti */}
      <div className="absolute top-0 right-0 bg-blue-600 text-white text-[10px] font-bold px-2 py-1 rounded-bl-lg">
        End-to-End Encrypted
      </div>

      <p className="text-slate-400 text-xs mb-3 font-medium uppercase tracking-widest">
        🛡️ {t.sectionTitle}
      </p>

      {pii ? (
        <>
          {/* Banka Sahibi */}
          <p className="text-slate-400 text-[10px] mb-0.5 uppercase tracking-widest">Ad Soyad</p>
          <p className="font-bold text-white text-base mb-3">{pii.bankOwner}</p>

          {/* IBAN */}
          <p className="text-slate-400 text-[10px] mb-0.5 uppercase tracking-widest">IBAN</p>
          <p className="font-mono text-emerald-400 mb-3 break-all text-sm tracking-wider">
            {pii.iban}
          </p>

          {/* Aksiyon butonları */}
          <div className="flex space-x-2 mb-3">
            <button
              onClick={handleCopyIban}
              className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium py-2 rounded-lg transition border border-slate-600"
            >
              {copied ? t.copied : t.copyIban}
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
              className="flex items-center justify-center space-x-2 w-full py-2.5 rounded-xl bg-[#24A1DE]/10 border border-[#24A1DE]/30 text-[#24A1DE] hover:bg-[#24A1DE]/20 hover:border-[#24A1DE]/50 hover:shadow-[0_0_15px_rgba(36,161,222,0.2)] text-sm font-bold transition-all mb-3"
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

          {/* Güvenlik notu */}
          <div className="p-2 bg-slate-800 rounded-lg flex items-start space-x-2 border border-slate-700">
            <span className="text-sm shrink-0">🛡️</span>
            <p className="text-[10px] text-slate-400 leading-tight">{t.notice}</p>
          </div>
        </>
      ) : (
        <div className="text-center py-4">
          <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
          <p className="text-slate-400 text-sm">{t.loading}</p>
        </div>
      )}
    </div>
  );
}
