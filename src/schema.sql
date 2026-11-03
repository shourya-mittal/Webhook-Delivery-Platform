-- Webhook delivery platform schema.
-- Design rule: an event is persisted (with its fan-out deliveries) in ONE
-- transaction before any delivery is attempted. Nothing is "in memory only".

-- gen_random_uuid() is built in since PostgreSQL 13, so no extension is needed.

CREATE TABLE IF NOT EXISTS endpoints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url         text NOT NULL,
  secret      text NOT NULL,                 -- HMAC signing secret
  event_types text[] NOT NULL DEFAULT '{}',  -- empty = subscribe to all
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Human-readable label for the dashboard (added after v0.1; nullable).
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS name text;

CREATE TABLE IF NOT EXISTS events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE,               -- sender-supplied; dedupes ingestion
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per (event, endpoint): the unit of delivery work.
CREATE TABLE IF NOT EXISTS deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  -- pending   : waiting for next_attempt_at
  -- in_flight : claimed by a worker; lease expires at locked_until
  -- succeeded : receiver returned 2xx
  -- dead      : exceeded max attempts (dead-letter), replayable
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_flight','succeeded','dead')),
  attempt_count   int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, endpoint_id)
);

CREATE INDEX IF NOT EXISTS deliveries_due_idx
  ON deliveries (next_attempt_at) WHERE status IN ('pending','in_flight');

-- Append-only log of every HTTP attempt.
CREATE TABLE IF NOT EXISTS attempts (
  id           bigserial PRIMARY KEY,
  delivery_id  uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  status_code  int,
  error        text,
  duration_ms  int NOT NULL
);

CREATE INDEX IF NOT EXISTS attempts_delivery_idx ON attempts (delivery_id);
