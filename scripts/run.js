/**
 * Main watchdog entrypoint — runs both checks in sequence, writes a
 * coverage_audits row (if the service role key is present), and exits
 * non-zero if anything alerted so the GitHub Action surfaces it.
 */

import { checkLiveness } from './liveness.js';
import { checkCoverage } from './coverage.js';
import { createClient } from '@supabase/supabase-js';

async function writeAuditRow(liveness, coverage) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // If no service role key, skip the write — stdout logging only
  if (!supabaseUrl || !serviceRoleKey) {
    console.log('\n(No SUPABASE_SERVICE_ROLE_KEY set — skipping coverage_audits write)');
    return { written: false };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { error } = await supabase
    .from('coverage_audits')
    .insert({
      events_in_db: liveness.events_count,
      events_on_luma: coverage.ai_events_on_luma,
      coverage_percentage: coverage.coverage_percentage,
      gap_event_titles: coverage.gaps ? coverage.gaps.map(g => g.title) : [],
      liveness_status: liveness.status,
      notes: `${liveness.reason} | ${coverage.reason}`,
    });

  if (error) {
    // The table may not exist yet — graceful degradation
    if (error.code === '42P01' || error.message.includes('does not exist')) {
      console.log('\n(coverage_audits table does not exist yet — skipping write)');
      return { written: false, reason: 'table_missing' };
    }
    console.error(`\n⚠️  Failed to write audit row: ${error.message}`);
    return { written: false, reason: error.message };
  }
  return { written: true };
}

async function main() {
  if (process.env.WATCHDOG_DISABLED === '1') {
    console.log('🔒 WATCHDOG_DISABLED=1 — skipping all checks.');
    process.exit(0);
  }

  console.log('🐕 austin-ai-events-watchdog running');
  console.log(`   Time: ${new Date().toISOString()}\n`);

  let liveness;
  let coverage;
  let exitCode = 0;

  try {
    liveness = await checkLiveness();
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
    liveness = { status: 'error', error: e.message, events_count: null };
    exitCode = 2;
  }

  console.log();

  try {
    coverage = await checkCoverage();
    console.log('Coverage check:');
    console.log(`   Status:    ${coverage.status}`);
    console.log(`   Luma AI:   ${coverage.ai_events_on_luma}/${coverage.events_on_luma}`);
    console.log(`   DB:        ${coverage.events_in_db}`);
    console.log(`   Coverage:  ${coverage.coverage_percentage ?? 'n/a'}%`);
    console.log(`   Reason:    ${coverage.reason}`);
    if (coverage.gaps && coverage.gaps.length > 0) {
      console.log(`   Gaps (${coverage.gaps.length}):`);
      for (const g of coverage.gaps.slice(0, 10)) {
        console.log(`     - ${g.title} (${g.start_time})`);
      }
    }
    if (coverage.alert) {
      console.error(`\n   ⚠️  COVERAGE ALERT`);
      exitCode = Math.max(exitCode, 1);
    }
  } catch (e) {
    console.error(`\n💥 Coverage check crashed: ${e.message}`);
    coverage = { status: 'error', error: e.message };
    exitCode = 2;
  }

  console.log();
  if (liveness && coverage) {
    await writeAuditRow(liveness, coverage);
  }

  console.log(`\n🐕 Watchdog exit: ${exitCode}`);
  process.exit(exitCode);
}

main().catch(e => {
  console.error('💥 Watchdog crashed:', e);
  process.exit(2);
});
