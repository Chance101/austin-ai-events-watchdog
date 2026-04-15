# Austin AI Events — Watchdog

**External ground-truth monitor** for [austinai.events](https://austinai.events).

This is a deliberately separate repository from the main `austin-ai-events` project. It exists because a self-modifying system needs at least one measurement of success that lives outside its own modification scope. If the main system could touch this, it could also silence it — exactly the "confident lobotomy" failure mode.

## What it does

Two checks on a cron schedule:

### 1. Liveness check (every 6 hours)

Reads the main Supabase `events` table directly (read-only anon key), counts upcoming events in the next 14 days, and alerts if the count drops below a threshold.

This catches:
- **Dead system** — all scrapers report healthy, grade stays A, but the calendar has no upcoming events
- **Confident lobotomy** — the monitor disables a subsystem, calendar starts going stale, no internal alarm fires

### 2. Coverage ground truth (every 6 hours)

Fetches `https://luma.com/austin` (independent of the main repo's Luma parser) and counts AI-related events visible on the public page. Compares against what the main Supabase DB has. Outputs a coverage percentage and a gap list.

This catches:
- **Silent discovery failure** — Luma has 15 AI events, we have 4, nobody noticed
- **Parser drift** — our Luma parser used to work, now it returns nothing

## Why it lives in a separate repo

The main `austin-ai-events` project has an autonomous outer loop that can modify code. Its scope rules put `.github/workflows/*` in the "Never" tier — but "Never" is a policy, not a wall. A sufficiently aggressive planner could reason around the rule, or a future human could accidentally loosen it.

A separate repo with separate permissions is a wall. The main system cannot touch `austin-ai-events-watchdog/*` regardless of what it decides.

This is the single non-negotiable guardrail from the 2026-04-08 five-agent autonomy architecture analysis: **at least one measurement of success must live outside the system's control.**

## Setup

Create the repo on GitHub and push:

```bash
gh repo create austin-ai-events-watchdog --public --source=. --push
```

Add secrets to the GitHub repo (Settings → Secrets → Actions):

- `SUPABASE_URL` — same value as the main project (read-only usage)
- `SUPABASE_ANON_KEY` — read-only key (not service role)
- `ALERT_EMAIL` — where to send alerts when thresholds trip (optional; if unset, alerts go to the workflow log only)
- `ALERT_THRESHOLD_EVENTS` — minimum upcoming events in the 14-day window (default: 5)

## Running locally

```bash
cd austin-ai-events-watchdog
npm install

# Copy .env.example to .env and fill in values
cp .env.example .env

# Run the liveness check
npm run liveness

# Run the coverage check
npm run coverage

# Run both
npm start
```

## Output

Every run writes a row to the `coverage_audits` table in the main Supabase DB (read-write via service role is optional — if you want the watchdog to write its findings, add `SUPABASE_SERVICE_ROLE_KEY`; otherwise it logs to stdout only).

```sql
CREATE TABLE coverage_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  events_in_db INTEGER NOT NULL,
  events_on_luma INTEGER,
  coverage_percentage NUMERIC,
  gap_event_titles TEXT[],
  liveness_status TEXT,  -- 'healthy' | 'degraded' | 'empty'
  notes TEXT
);
```

Create this table via the main project's migrations when you're ready to use it — the watchdog gracefully handles the table being absent and logs to stdout only.

## What this is NOT

- Not a replacement for the main system's own monitor — they measure different things
- Not a real-time alerter (6h cron is enough for catching regressions)
- Not a full coverage audit (Luma is one source of many; extending to Meetup/Eventbrite is planned for v2)

## Kill switch

If the watchdog itself is misbehaving, set `WATCHDOG_DISABLED=1` as a GitHub Actions secret. The workflow short-circuits and emits a "watchdog disabled" log entry. This is the only env var the main system cannot touch.
