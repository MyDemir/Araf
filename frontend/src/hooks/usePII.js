"use strict";

/**
 * usePII — Güvenli IBAN + Telegram Fetch Hook
 *
 * Güvenlik Özellikleri:
 *   - IBAN asla React state'te kalıcı olarak saklanmaz
 *   - Trade room unmount olduğunda IBAN + Telegram otomatik temizlenir
 *   - Her gösterimde yeniden fetch yapılır (cache yok)
 *   - Kısa ömürlü PII token ile 2 adımlı erişim
 *   - tüm authentication httpOnly cookie üzerinden (credentials: include)
 *
 * YÜKS-06 Fix: Refresh Token Desenkronizasyonu düzeltildi.
 *   ÖNCEKİ: Düz `fetch` kullanılıyordu. JWT süresi dolarsa 401 alınıyor ama
 *   hook kendi başına token yenileyemiyordu → "PII erişimi reddedildi" hatası
 *   → yetkili kullanıcı IBAN'a erişemez → gereksiz uyuşmazlık tetiklenebilir.
 *   ŞİMDİ: App.jsx'teki `authenticatedFetch` referansı prop olarak alınıyor.
 *   Bu sayede JWT süresi dolduğunda otomatik yenileme yapılıyor.
 *
 * YÜKS-07 Fix: İstek Yarışı (Race Condition) düzeltildi.
 *   ÖNCEKİ: Önceki isteği iptal eden mekanizma yoktu. Butona hızlıca art arda
 *   basılırsa birden fazla request → eski yanıt yeni yanıtın üzerine yazabilirdi.
 *   ŞİMDİ: Her yeni `fetchPII` çağrısında AbortController ile önceki istek iptal
 *   ediliyor. Sadece en son istek sonucu state'e yazılıyor.
 *
 * Kullanım (App.jsx'te):
 *   const { pii, loading, error, fetchPII, clearPII } = usePII(tradeId, authenticatedFetch);
 *   <button onClick={fetchPII}>IBAN'ı Göster</button>
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || (
  import.meta.env.DEV ? 'http://localhost:4000' : ''
);

/**
 * @param {string}   tradeId           Backend trade ID (MongoDB _id)
 * @param {Function} authenticatedFetch App.jsx'ten gelen JWT yönetimli fetch wrapper'ı
 */
export function usePII(tradeId, authenticatedFetch) {
  const [pii, setPii]         = useState(null);   // { bankOwner, iban, telegram }
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const mountedRef     = useRef(true);
  // YÜKS-07 Fix: Aktif isteği iptal etmek için AbortController ref'i
  const abortCtrlRef   = useRef(null);

  // [TR] Trade ID değişince veya unmount'ta state temizle + aktif istek iptal et
  // [EN] Clear state and abort active request on tradeId change or unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setPii(null); // unmount → IBAN + Telegram bellekten sil
      if (abortCtrlRef.current) {
        abortCtrlRef.current.abort();
      }
    };
  }, [tradeId]);

  const fetchPII = useCallback(async () => {
    if (!tradeId) {
      setError('Trade ID eksik.');
      return;
    }

    // YÜKS-07 Fix: Önceki istek varsa iptal et, yeni AbortController oluştur
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
    }
    abortCtrlRef.current = new AbortController();
    const { signal } = abortCtrlRef.current;

    setLoading(true);
    setError(null);

    try {
      // ADIM 1: Kısa ömürlü PII erişim token'ı al
      // YÜKS-06 Fix: authenticatedFetch prop'u yoksa düz fetch ile fallback yap
      const doFetch = authenticatedFetch || ((url, opts) =>
        fetch(url, { ...opts, credentials: 'include' })
      );

      const tokenRes = await doFetch(
        `${API_BASE}/api/pii/request-token/${tradeId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
        }
      );

      if (!tokenRes.ok) {
        const body = await tokenRes.json().catch(() => ({}));
        throw new Error(body.error || `PII erişimi reddedildi (${tokenRes.status})`);
      }

      const { piiToken } = await tokenRes.json();

      // [TR] İptal edildiyse devam etme
      if (signal.aborted) return;

      // ADIM 2: Kısa ömürlü PII token ile şifreli veriyi çöz
      const piiRes = await fetch(`${API_BASE}/api/pii/${tradeId}`, {
        headers: { 'Authorization': `Bearer ${piiToken}` },
        signal,
      });

      if (!piiRes.ok) {
        const body = await piiRes.json().catch(() => ({}));
        throw new Error(body.error || `PII verisi alınamadı (${piiRes.status})`);
      }

      const data = await piiRes.json();

      // [TR] Sadece hâlâ mount ve iptal edilmemişse state güncelle
      if (mountedRef.current && !signal.aborted) {
        setPii({
          bankOwner: data.bankOwner || '—',
          iban:      data.iban      || '—',
          telegram:  data.telegram  || null,
        });
      }
    } catch (err) {
      // [TR] AbortError beklenen bir iptal — state'e hata yazma
      // [EN] AbortError is an expected cancellation — don't write error to state
      if (err.name === 'AbortError') return;

      if (mountedRef.current) {
        setError(err.message);
      }
    } finally {
      if (mountedRef.current && !signal.aborted) {
        setLoading(false);
      }
    }
  }, [tradeId, authenticatedFetch]);

  const clearPII = useCallback(() => {
    // [TR] Aktif istek varsa iptal et
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    setPii(null);
    setError(null);
  }, []);

  return { pii, loading, error, fetchPII, clearPII };
}
