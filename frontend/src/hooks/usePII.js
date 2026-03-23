"use strict";

/**
 * usePII — Güvenli IBAN + Telegram Fetch Hook
 *
 * Güvenlik Özellikleri:
 * - IBAN asla React state'te kalıcı olarak saklanmaz
 * - Trade room unmount olduğunda IBAN + Telegram otomatik temizlenir
 * - Her gösterimde yeniden fetch yapılır (cache yok)
 * - Kısa ömürlü PII token ile 2 adımlı erişim
 *
 * Kullanım:
 * const { pii, loading, error, fetchPII, clearPII } = usePII(tradeId);
 * <button onClick={fetchPII}>IBAN'ı Göster</button>
 * {pii && <p>{pii.iban}</p>}
 * {pii?.telegram && <a href={`https://t.me/${pii.telegram}`}>Telegram</a>}
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || (
  import.meta.env.DEV ? 'http://localhost:4000' : ''
);

/**
 * @param {string} tradeId Backend trade ID (MongoDB _id veya onchain_escrow_id)
 */
export function usePII(tradeId) {
  const [pii, setPii]         = useState(null);   // { bankOwner, iban, telegram }
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const mountedRef = useRef(true);

  // Trade room'dan çıkınca veya tradeId değişince otomatik temizle
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setPii(null);   // unmount → IBAN + Telegram bellekten sil
    };
  }, [tradeId]);

  const fetchPII = useCallback(async () => {
    if (!tradeId) {
      setError('Trade ID eksik.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Kısa ömürlü PII erişim token'ı al (httpOnly cookie otomatik gönderilir)
      const tokenRes = await fetch(`${API_BASE}/api/pii/request-token/${tradeId}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.json().catch(() => ({}));
        throw new Error(body.error || `PII erişimi reddedildi (${tokenRes.status})`);
      }

      const { piiToken } = await tokenRes.json();

      // Kısa ömürlü PII token ile şifreli veriyi çöz (Trade-scoped)
      const piiRes = await fetch(`${API_BASE}/api/pii/${tradeId}`, {
        headers: { 'Authorization': `Bearer ${piiToken}` },
      });

      if (!piiRes.ok) {
        const body = await piiRes.json().catch(() => ({}));
        throw new Error(body.error || `PII verisi alınamadı (${piiRes.status})`);
      }

      const data = await piiRes.json();

      if (mountedRef.current) {
        setPii({
          bankOwner: data.bankOwner || '—',
          iban:      data.iban      || '—',
          telegram:  data.telegram  || null,
        });
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err.message);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [tradeId]);

  const clearPII = useCallback(() => {
    setPii(null);
    setError(null);
  }, []);

  return { pii, loading, error, fetchPII, clearPII };
}
