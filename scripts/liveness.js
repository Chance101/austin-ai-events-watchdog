/**
 * Liveness check — reads the main Supabase events table and counts
 * upcoming events in the next 14 days. Alerts if the count is below
 * the threshold.
 *
 * This is the "smoke detector" of the autonomy architecture. It lives
 * outside the main repo's modification scope so the main system cannot
 * disable it. When it beeps, a human investigates.
 */

import { createClient } from '@supabase/supabase-js';

// MUST match LOOKAHEAD_DAYS in coverage.js + meetupFind.js + run.js writeAuditRow.
const LOOKAHEAD_DAYS = 30;

export async function checkLiveness(city = 'austin') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const threshold = parseInt(process.env.ALERT_THRESHOLD_EVENTS || '5', 10);

  if (!supabaseUrl || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  }

  const supabase = createClient(supabaseUrl, anonKey);
  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  const { data, error, count } = await supabase
    .from('events')
    .select('id, title, start_time', { count: 'exact' })
    .eq('city', city)
    .is('deleted_at', null)
    .gte('start_time', now.toISOString())
    .lte('start_time', horizon.toISOString())
    .order('start_time', { ascending: true });

  if (error) {
    return {
      status: 'error',
      city,
      error: error.message,
      events_count: null,
      threshold,
      alert: true,
      reason: `Supabase query failed: ${error.message}`,
    };
  }

  const events = data || [];
  const eventsCount = count ?? events.length;

  let status = 'healthy';
  let alert = false;
  let reason = `${eventsCount} upcoming events for ${city} in the next ${LOOKAHEAD_DAYS} days (threshold: ${threshold})`;

  if (eventsCount === 0) {
    status = 'empty';
    alert = true;
    reason = `No upcoming events for ${city} in the next ${LOOKAHEAD_DAYS} days — calendar is empty. This is either a dead system or a very quiet month.`;
  } else if (eventsCount < threshold) {
    status = 'degraded';
    alert = true;
    reason = `Only ${eventsCount} upcoming events for ${city} in the next ${LOOKAHEAD_DAYS} days (threshold: ${threshold}). Investigate whether scrapers are healthy.`;
  }

  return {
    status,
    city,
    events_count: eventsCount,
    threshold,
    alert,
    reason,
    lookahead_days: LOOKAHEAD_DAYS,
    sample_titles: events.slice(0, 5).map(e => e.title),
  };
}

// CLI entry point: node scripts/liveness.js
const isDirectRun = process.argv[1] && process.argv[1].endsWith('liveness.js');
if (isDirectRun) {
  const city = process.env.CITY || 'austin';
  checkLiveness(city)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (result.alert) {
        console.error(`\n⚠️  LIVENESS ALERT: ${result.reason}`);
        process.exit(1);
      }
      console.log(`\n✅ Liveness check passed: ${result.reason}`);
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Liveness check failed:', error.message);
      process.exit(2);
    });
}
