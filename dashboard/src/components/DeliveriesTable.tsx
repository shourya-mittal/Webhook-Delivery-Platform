import { Fragment, useEffect, useState } from "react";
import { api, type Attempt, type Delivery, type DeliveryStatus } from "../api";
import { clockTime, endpointLabel, formatMs, relativeTime } from "../format";
import { usePoll } from "../usePoll";
import { StatusPill } from "./StatusPill";

const FILTERS: { label: string; status?: DeliveryStatus }[] = [
  { label: "All" },
  { label: "Dead-lettered", status: "dead" },
  { label: "Pending", status: "pending" },
  { label: "Sending", status: "in_flight" },
  { label: "Delivered", status: "succeeded" },
];

function AttemptLog({ deliveryId, attemptCount }: { deliveryId: string; attemptCount: number }) {
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  // Refetch when the attempt count changes, so the log follows live retries.
  useEffect(() => {
    let live = true;
    api.attempts(deliveryId).then((a) => live && setAttempts(a)).catch(() => {});
    return () => { live = false; };
  }, [deliveryId, attemptCount]);

  if (!attempts) return <p className="muted">Loading attempts…</p>;
  if (attempts.length === 0) return <p className="muted">No attempts yet: waiting for a worker.</p>;
  return (
    <ol className="attempts">
      {attempts.map((a, i) => {
        const ok = a.statusCode !== null && a.statusCode >= 200 && a.statusCode < 300;
        return (
          <li key={a.id} className={ok ? "attempt-ok" : "attempt-fail"}>
            <span className="attempt-n">#{i + 1}</span>
            <span className="mono">{clockTime(a.attemptedAt)}</span>
            <span className={`mono ${ok ? "text-good" : "text-critical"}`}>
              {ok ? "✓" : "✕"} {a.statusCode ?? "—"}
            </span>
            <span className="muted">{a.error ?? "OK"}</span>
            <span className="mono num">{formatMs(a.durationMs)}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function DeliveriesTable({ now, active, onReplayed }: { now: number; active: boolean; onReplayed: () => void }) {
  const [filter, setFilter] = useState<DeliveryStatus | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { data, refresh } = usePoll(() => api.deliveries(filter), 2000, active);

  useEffect(() => { void refresh(); }, [filter, refresh]);

  async function replay(d: Delivery) {
    setBusy(d.id);
    try {
      await api.replay(d.id);
      setNotice(`Replayed ${d.type} → ${endpointLabel({ name: d.endpointName, url: d.url })}. It is back in the queue.`);
      await refresh();
      onReplayed();
    } catch (e) {
      setNotice(`Replay failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Deliveries</h2>
          <p className="muted">Newest activity first · click a row for its attempt log</p>
        </div>
        <div className="tabs" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              role="tab"
              aria-selected={filter === f.status}
              className={filter === f.status ? "tab tab-active" : "tab"}
              onClick={() => { setFilter(f.status); setOpen(null); }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {notice && (
        <div className="notice" role="status">
          {notice}
          <button className="link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="table-wrap">
        <table className="table deliveries">
          <thead>
            <tr>
              <th>Status</th>
              <th>Event</th>
              <th>Receiver</th>
              <th className="num">Attempts</th>
              <th>Last error</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.length === 0 && (
              <tr><td colSpan={7} className="muted empty">No deliveries in this view.</td></tr>
            )}
            {data?.map((d) => (
              <Fragment key={d.id}>
                <tr
                  className={open === d.id ? "row row-open" : "row"}
                  onClick={() => setOpen(open === d.id ? null : d.id)}
                  aria-expanded={open === d.id}
                >
                  <td><StatusPill status={d.status} attemptCount={d.attemptCount} /></td>
                  <td>
                    <span className="mono">{d.type}</span>
                    <span className="muted mono small">{d.eventId.slice(0, 8)}</span>
                  </td>
                  <td>{endpointLabel({ name: d.endpointName, url: d.url })}</td>
                  <td className="num">{d.attemptCount}</td>
                  <td className="muted truncate" title={d.lastError ?? undefined}>{d.lastError ?? "—"}</td>
                  <td className="muted nowrap">
                    {d.status === "pending" && d.attemptCount > 0
                      ? Date.parse(d.nextAttemptAt) > now
                        ? `next try ${relativeTime(d.nextAttemptAt, now)}`
                        : "next try now"
                      : relativeTime(d.updatedAt, Math.max(now, Date.parse(d.updatedAt)))}
                  </td>
                  <td className="actions">
                    {d.status === "dead" && (
                      <button
                        className="btn"
                        disabled={busy === d.id}
                        onClick={(e) => { e.stopPropagation(); void replay(d); }}
                      >
                        {busy === d.id ? "Replaying…" : "Replay"}
                      </button>
                    )}
                  </td>
                </tr>
                {open === d.id && (
                  <tr className="row-detail">
                    <td colSpan={7}>
                      <AttemptLog deliveryId={d.id} attemptCount={d.attemptCount} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
