/**
 * Main watchdog entrypoint — runs both checks in sequence, writes a
 * coverage_audits row (if the service role key is present), and exits
 * non-zero if anything alerted so the GitHub Action surfaces it.
 *
 * Watchdog principle (2026-04-29 reset): writes ONLY counts back to the
 * agent. No event titles, no gap lists, no per-platform breakdown,
 * no coverage percentage. Just events_in_db and events_seen.
 */

import { checkLiveness } from './liveness.js';
import { checkCoverage } from './coverage.js';
import { createClient } from '@supabase/supabase-js';

async function writeAuditRow(city, liveness, coverage) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.log('\n(No SUPABASE_SERVICE_ROLE_KEY set — skipping coverage_audits write)');
    return { written: false };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const eventsInDb = liveness.events_count;
  const eventsSeen = coverage.events_seen ?? null;
  const eventsSeenInDb = coverage.events_seen_in_db ?? null;
  const eventsMissing = (eventsSeen != null && eventsSeenInDb != null)
    ? eventsSeen - eventsSeenInDb
    : null;
  // MUST match LOOKAHEAD_DAYS in coverage.js, meetupFind.js, liveness.js.
  const lookaheadDays = 30;

  const { error } = await supabase
    .from('coverage_audits')
    .insert({
      city,
      events_in_db: eventsInDb,
      events_seen: eventsSeen,
      events_seen_in_db: eventsSeenInDb,
      lookahead_days: lookaheadDays,
      liveness_status: liveness.status,
      notes: `liveness=${liveness.status}, in_db=${eventsInDb ?? 'n/a'}, seen=${eventsSeen ?? 'n/a'}, seen_in_db=${eventsSeenInDb ?? 'n/a'}, missing=${eventsMissing ?? 'n/a'} (next ${lookaheadDays}d)`,
      // Legacy columns intentionally left null — watchdog no longer leaks
      // specific events, per-platform counts, or coverage percentages.
      events_on_luma: null,
      coverage_percentage: null,
      gap_event_titles: null,
    });

  if (error) {
    if (error.code === '42P01' || error.message.includes('does not exist')) {
      console.log('\n(coverage_audits table does not exist yet — skipping write)');
      return { written: false, reason: 'table_missing' };
    }
    console.error(`\n⚠️  Failed to write audit row: ${error.message}`);
    return { written: false, reason: error.message };
  }
  return { written: true };
}

async function runForCity(city) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🐕 Watchdog: city=${city}`);
  console.log('='.repeat(50));

  let liveness;
  let coverage;
  let exitCode = 0;

  try {
    liveness = await checkLiveness(city);
    console.log('Liveness check:');
    console.log(`   Status:    ${liveness.status}`);
    console.log(`   Events:    ${liveness.events_count}/${liveness.threshold}`);
    console.log(`   Reason:    ${liveness.reason}`);
    if (liveness.alert) {
      console.error(`\n   ⚠️  LIVENESS ALERT`);
      exitCode = 1;
    }
  } catch (e) {
    console.error(`\n💥 Liveness check crashed: ${e.message}`);
    liveness = { status: 'error', city, error: e.message, events_count: null };
    exitCode = 2;
  }

  console.log();

  try {
    coverage = await checkCoverage(city);
    const missing = (coverage.events_seen != null && coverage.events_seen_in_db != null)
      ? coverage.events_seen - coverage.events_seen_in_db
      : 'n/a';
    console.log('Coverage check:');
    console.log(`   Status:    ${coverage.status}`);
    console.log(`   In DB:     ${coverage.events_in_db ?? 'n/a'}`);
    console.log(`   Seen:      ${coverage.events_seen ?? 'n/a'}`);
    console.log(`   In both:   ${coverage.events_seen_in_db ?? 'n/a'}`);
    console.log(`   Missing:   ${missing}`);
    console.log(`   Reason:    ${coverage.reason}`);
    if (coverage.alert) {
      console.error(`\n   ⚠️  COVERAGE ALERT`);
      exitCode = Math.max(exitCode, 1);
    }
  } catch (e) {
    console.error(`\n💥 Coverage check crashed: ${e.message}`);
    coverage = { status: 'error', city, error: e.message, events_in_db: null, events_seen: null };
    exitCode = 2;
  }

  console.log();
  if (liveness && coverage) {
    await writeAuditRow(city, liveness, coverage);
  }

  return exitCode;
}

async function main() {
  if (process.env.WATCHDOG_DISABLED === '1') {
    console.log('🔒 WATCHDOG_DISABLED=1 — skipping all checks.');
    process.exit(0);
  }

  console.log('🐕 austin-ai-events-watchdog running');
  console.log(`   Time: ${new Date().toISOString()}`);

  const citiesEnv = process.env.WATCHDOG_CITIES || 'austin';
  const cities = citiesEnv.split(',').map(s => s.trim()).filter(Boolean);

  let maxExit = 0;
  for (const city of cities) {
    const code = await runForCity(city);
    maxExit = Math.max(maxExit, code);
  }

  console.log(`\n🐕 Watchdog exit: ${maxExit} (checked ${cities.length} cities)`);
  process.exit(maxExit);
}

main().catch(e => {
  console.error('💥 Watchdog crashed:', e);
  process.exit(2);
});
