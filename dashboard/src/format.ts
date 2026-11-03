const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export const formatCount = (n: number) => (n < 1000 ? String(n) : compact.format(n));

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** "12s ago" / "in 4s" relative to `now`. */
export function relativeTime(iso: string, now: number): string {
  const diff = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diff);
  const text =
    abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.floor(abs / 60)}m` : `${Math.floor(abs / 3600)}h`;
  if (abs < 1) return "now";
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const minuteLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const endpointLabel = (e: { name: string | null; url: string }) =>
  e.name ?? new URL(e.url).host;
