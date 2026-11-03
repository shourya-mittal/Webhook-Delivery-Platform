import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Re-run `load` every `intervalMs` while `enabled`. Keeps the last good data
 * on error so a blip does not blank the screen; `error` says the API is down.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, enabled = true) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [updatedAt, setUpdatedAt] = useState<number | undefined>();
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(undefined);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs, refresh]);

  return { data, error, updatedAt, refresh };
}

/** A clock that ticks every second, for "3s ago" labels. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Width of an element, tracked with ResizeObserver (for responsive SVG). */
export function useWidth<E extends HTMLElement>() {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
