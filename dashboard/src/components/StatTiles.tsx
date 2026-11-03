import type { Stats } from "../api";
import { formatCount, formatMs } from "../format";

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">
        {tone && <i className={`swatch swatch-${tone}`} aria-hidden="true" />}
        {label}
      </div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub muted">{sub}</div>
    </div>
  );
}

export function StatTiles({ stats }: { stats: Stats }) {
  const d = stats.deliveries;
  const inProgress = d.pending + d.in_flight;
  const finished = d.succeeded + d.dead;
  const events30 = stats.timeline.reduce((n, m) => n + m.events, 0);
  return (
    <div className="tiles">
      <Tile label="Events received" value={formatCount(events30)} sub="last 30 minutes" />
      <Tile
        label="Delivered"
        tone="good"
        value={formatCount(d.succeeded)}
        sub={finished ? `${((d.succeeded / finished) * 100).toFixed(1)}% of finished deliveries` : "no finished deliveries yet"}
      />
      <Tile label="In progress" tone="warning" value={formatCount(inProgress)} sub={`${d.in_flight} sending now · rest queued or retrying`} />
      <Tile label="Dead-lettered" tone="critical" value={formatCount(d.dead)} sub={d.dead ? "out of retries, waiting for replay" : "nothing needs attention"} />
      <Tile
        label="Attempt latency p95"
        value={stats.lastHour.attempts ? formatMs(stats.lastHour.p95Ms) : "—"}
        sub={stats.lastHour.attempts ? `avg ${formatMs(stats.lastHour.avgMs)} · ${formatCount(stats.lastHour.attempts)} attempts in the last hour` : "no attempts in the last hour"}
      />
    </div>
  );
}
