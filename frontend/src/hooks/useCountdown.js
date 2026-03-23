import { useState, useEffect } from 'react';

/**
 * Belirli bir hedef tarihe kadar olan süreyi hesaplayan ve her saniye güncelleyen
 * bir React hook'u.
 *
 * @param {Date | string | null} targetDate - Geri sayımın yapılacağı hedef tarih.
 * @returns {{days: number, hours: number, minutes: number, seconds: number, isFinished: boolean}}
 *          Kalan süreyi ve geri sayımın bitip bitmediğini belirten bir nesne.
 */
export function useCountdown(targetDate) {
  const [timeLeft, setTimeLeft] = useState({
    days: 0, hours: 0, minutes: 0, seconds: 0, isFinished: true,
  });

  useEffect(() => {
    if (!targetDate) {
      setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0, isFinished: true });
      return;
    }

    const targetTime = new Date(targetDate).getTime();

    const interval = setInterval(() => {
      const now = new Date().getTime();
      const distance = targetTime - now;

      if (distance < 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0, isFinished: true });
        clearInterval(interval);
        return;
      }

      const days = Math.floor(distance / (1000 * 60 * 60 * 24));
      const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((distance % (1000 * 60)) / 1000);

      setTimeLeft({ days, hours, minutes, seconds, isFinished: false });
    }, 1000);

    // Cleanup
    return () => clearInterval(interval);
  }, [targetDate]);

  return timeLeft;
}
