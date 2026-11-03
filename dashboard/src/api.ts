// Typed client for the platform API (see src/server.ts in the backend).
const BASE = import.meta.env.VITE_API_BASE ?? "/api";

export type DeliveryStatus = "pending" | "in_flight" | "succeeded" | "dead";

export interface Stats {
  deliveries: Record<DeliveryStatus, number>;
  lastHour: { attempts: number; avgMs: number; p95Ms: number };
  timeline: {
    minute: string;
    events: number;
    okAttempts: number;
    failedAttempts: number;
  }[];
  endpoints: {
    id: string;
    name: string | null;
    url: string;
    succeeded: number;
    retrying: number;
    dead: number;
  }[];
}

export interface Delivery {
  id: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastError: string | null;
  updatedAt: string;
  eventId: string;
  type: string;
  endpointId: string;
  url: string;
  endpointName: string | null;
}

export interface Attempt {
  id: string;
  attemptedAt: string;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  stats: () => request<Stats>("/stats"),
  deliveries: (status?: DeliveryStatus) =>
    request<Delivery[]>(`/deliveries?limit=100${status ? `&status=${status}` : ""}`),
  attempts: (deliveryId: string) =>
    request<Attempt[]>(`/deliveries/${deliveryId}/attempts`),
  replay: (deliveryId: string) =>
    request<{ replayed: boolean }>(`/deliveries/${deliveryId}/replay`, {
      method: "POST",
    }),
};
