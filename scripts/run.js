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
      // Legacy columns (events_on_luma, coverage_percentage, gap_event_titles)
      // were dropped during the count-only reset and are no longer written.
      // The principle is enforced structurally by their absence from the schema.
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

async function runForCity(cityRow) {
  const city = cityRow.slug;
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
    coverage = await checkCoverage(cityRow);
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

/**
 * Auto-detect the cities to watch by querying the global `cities` registry.
 * Includes any city with status='active' or status='beta'.
 *
 * Independence note: this is a one-way read. The watchdog never writes back
 * to the cities table — see project_watchdog_independence_from_bootstrap.md.
 */
async function loadActiveCities() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY (or SERVICE_ROLE_KEY) are required');
  }
  const supabase = createClient(supabaseUrl, key);
  const { data, error } = await supabase
    .from('cities')
    .select('slug, name, full_name, country, status')
    .in('status', ['beta', 'active'])
    .order('slug');
  if (error) throw new Error(`Failed to load cities: ${error.message}`);
  return data || [];
}

async function main() {
  if (process.env.WATCHDOG_DISABLED === '1') {
    console.log('🔒 WATCHDOG_DISABLED=1 — skipping all checks.');
    process.exit(0);
  }

  console.log('🐕 austin-ai-events-watchdog running');
  console.log(`   Time: ${new Date().toISOString()}`);

  // Auto-detect from the cities registry. WATCHDOG_CITIES env stays as an
  // explicit override (filter the auto-detected set to just those slugs)
  // for testing or scoped runs.
  let cityRows;
  try {
    const allActive = await loadActiveCities();
    const overrideEnv = process.env.WATCHDOG_CITIES;
    if (overrideEnv) {
      const slugs = overrideEnv.split(',').map(s => s.trim()).filter(Boolean);
      cityRows = allActive.filter(c => slugs.includes(c.slug));
      console.log(`   Override: WATCHDOG_CITIES=${overrideEnv} → ${cityRows.length} cities`);
    } else {
      cityRows = allActive;
      console.log(`   Auto-detected ${cityRows.length} active cities: ${cityRows.map(c => c.slug).join(', ')}`);
    }
  } catch (e) {
    console.error(`💥 Failed to auto-detect cities: ${e.message}`);
    process.exit(2);
  }

  if (cityRows.length === 0) {
    console.log('🐕 No active cities to watch — exiting.');
    process.exit(0);
  }

  let maxExit = 0;
  for (const cityRow of cityRows) {
    const code = await runForCity(cityRow);
    maxExit = Math.max(maxExit, code);
  }

  console.log(`\n🐕 Watchdog exit: ${maxExit} (checked ${cityRows.length} cities)`);
  process.exit(maxExit);
}

main().catch(e => {
  console.error('💥 Watchdog crashed:', e);
  process.exit(2);
});
