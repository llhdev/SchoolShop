import { useEffect, useRef, useState } from 'react';

/**
 * Gates a loading spinner so it only appears on a genuinely slow FIRST load:
 *
 * - Delayed: the condition must stay true for `delayMs` before the spinner
 *   shows, so fast cache loads never flash it.
 * - One-way: once the condition has gone false once, it never shows again for
 *   the lifetime of the mounted screen — background re-syncs and navigations
 *   stay silent, while a misleading empty state still can't render before the
 *   first real load finishes.
 */
export function useDelayedLoading(loading: boolean, delayMs = 300): boolean {
  const [show, setShow] = useState(false);
  const doneOnce = useRef(false);

  useEffect(() => {
    if (!loading) {
      doneOnce.current = true;
      setShow(false);
      return;
    }
    if (doneOnce.current) return;
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [loading, delayMs]);

  return show;
}
