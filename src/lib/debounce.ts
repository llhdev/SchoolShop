/**
 * Trailing debounce: waits `delayMs` after the last call before invoking.
 * Rapid bursts (e.g. a multi-image product upload firing several realtime
 * INSERT events) collapse into a single invocation.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
}
