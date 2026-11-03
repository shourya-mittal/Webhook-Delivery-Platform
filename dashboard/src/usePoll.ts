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
  const inFlight = useRef(0);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++latest.current;
    inFlight.current++;
    try {
      const result = await loadRef.current();
      // A newer request (say, a changed filter) wins over a slower older one.
      if (id !== latest.current) return;
      setData(result);
      setError(undefined);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (id === latest.current) setError((e as Error).message);
    } finally {
      inFlight.current--;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    // Skip ticks while a request is pending: a waking server can take a minute.
    const t = setInterval(() => {
      if (inFlight.current === 0) void refresh();
    }, intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs, refresh]);

  return { data, error, updatedAt, refresh };
}

/**
 * False while the tab is hidden or nobody has touched it for `idleMs`. Polling
 * stops then, so a forgotten tab lets the free-tier server and database sleep.
 */
export function useActive(idleMs = 15 * 60_000): boolean {
  const [active, setActive] = useState(true);
  useEffect(() => {
    let last = Date.now();
    const onActivity = () => {
      last = Date.now();
      setActive(!document.hidden);
    };
    const events = ["pointermove", "pointerdown", "keydown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    document.addEventListener("visibilitychange", onActivity);
    const check = setInterval(() => {
      setActive(!document.hidden && Date.now() - last < idleMs);
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      document.removeEventListener("visibilitychange", onActivity);
      clearInterval(check);
    };
  }, [idleMs]);
  return active;
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
