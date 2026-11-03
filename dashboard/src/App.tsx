import { api } from "./api";
import { AttemptsChart } from "./components/AttemptsChart";
import { DeliveriesTable } from "./components/DeliveriesTable";
import { EndpointHealth } from "./components/EndpointHealth";
import { StatTiles } from "./components/StatTiles";
import { relativeTime } from "./format";
import { useNow, usePoll } from "./usePoll";

export function App() {
  const now = useNow();
  const stats = usePoll(api.stats, 2000);

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Webhook Delivery</h1>
          <p className="muted">Events in, signed webhooks out: retried, dead-lettered and replayable.</p>
        </div>
        <div className={stats.error ? "live live-down" : "live"} role="status">
          <i aria-hidden="true" />
          {stats.error
            ? `API unreachable (${stats.error}), retrying`
            : stats.updatedAt
              ? `Live · updated ${relativeTime(new Date(stats.updatedAt).toISOString(), now)}`
              : "Connecting…"}
        </div>
      </header>

      {stats.data ? (
        <>
          <StatTiles stats={stats.data} />
          <div className="grid-2">
            <AttemptsChart timeline={stats.data.timeline} />
            <EndpointHealth endpoints={stats.data.endpoints} />
          </div>
          <DeliveriesTable now={now} onReplayed={() => void stats.refresh()} />
        </>
      ) : (
        <div className="card empty muted">
          {stats.error
            ? "Can't reach the API. Start it with `npm run dev` (or `npm run demo`) in the project root."
            : "Loading…"}
        </div>
      )}
    </div>
  );
}
