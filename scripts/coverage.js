/**
 * Coverage ground truth — compares our Supabase events table against
 * events visible on luma.com/austin (the public Luma city page).
 *
 * This intentionally duplicates a small amount of Luma-parsing logic
 * from the main repo so the watchdog is fully independent. If the
 * main repo's Luma parser breaks, this watchdog's parser still works,
 * and that's the point.
 *
 * The output is a coverage percentage: what fraction of AI-related
 * Luma events in Austin are also in our calendar. Gaps are logged
 * with titles so a human can quickly see what's missing.
 */

import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const LOOKAHEAD_DAYS = 14;
const LUMA_AUSTIN_URL = 'https://luma.com/austin';

// Rough AI-relevance filter. Not perfect — the main system's validator
// is more sophisticated — but good enough for a coverage sanity check.
const AI_KEYWORDS = [
  'ai', 'a.i.', 'artificial intelligence', 'ml', 'machine learning',
  'llm', 'gpt', 'openai', 'claude', 'anthropic', 'agent', 'agents',
  'neural', 'deep learning', 'generative', 'vibe code', 'hackathon',
  'prompt engineering', 'rag', 'embedding', 'transformer',
];

function isAIRelated(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();
  return AI_KEYWORDS.some(kw => {
    if (kw.length <= 3) {
      return new RegExp(`\\b${kw}\\b`, 'i').test(text);
    }
    return text.includes(kw);
  });
}

/**
 * Fetch luma.com/austin and extract events from __NEXT_DATA__.
 * Independent copy of the relevant extraction logic — NOT an import
 * from the main repo (that would defeat the isolation purpose).
 */
async function fetchLumaAustinEvents() {
  const response = await fetch(LUMA_AUSTIN_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Luma fetch failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // Try __NEXT_DATA__ script tag first
  const nextDataScript = $('script#__NEXT_DATA__').html();
  if (!nextDataScript) {
    throw new Error('Luma page has no __NEXT_DATA__ script');
  }

  let nextData;
  try {
    nextData = JSON.parse(nextDataScript);
  } catch (e) {
    throw new Error(`Failed to parse __NEXT_DATA__: ${e.message}`);
  }

  const pageProps = nextData?.props?.pageProps || nextData?.pageProps;
  const entries = pageProps?.initialData?.events
    || pageProps?.initialData?.data?.events
    || [];

  if (!Array.isArray(entries)) {
    throw new Error('pageProps.initialData.events is not an array');
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const events = [];

  for (const entry of entries) {
    const evt = entry.event || entry;
    if (!evt.name || !evt.start_at) continue;
    const startDate = new Date(evt.start_at);
    if (isNaN(startDate)) continue;
    if (startDate < now || startDate > horizon) continue;

    const url = evt.url ? `https://lu.ma/${evt.url}` : null;
    events.push({
      title: evt.name,
      start_time: evt.start_at,
      url,
    });
  }

  return events;
}

/**
 * Fetch our Supabase events in the lookahead window.
 */
async function fetchOurEvents() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  }

  const supabase = createClient(supabaseUrl, anonKey);
  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('events')
    .select('id, title, start_time, url')
    .is('deleted_at', null)
    .gte('start_time', now.toISOString())
    .lte('start_time', horizon.toISOString());

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }
  return data || [];
}

/**
 * Check if two events match by URL or by title + same-day heuristic.
 */
function eventsMatch(lumaEvt, ourEvt) {
  if (lumaEvt.url && ourEvt.url) {
    // Normalize for comparison
    const l = lumaEvt.url.toLowerCase().replace(/\/$/, '');
    const o = ourEvt.url.toLowerCase().replace(/\/$/, '');
    if (l === o) return true;
    // Luma slugs may appear in our URL even if full URL differs
    const lumaSlug = lumaEvt.url.split('/').pop();
    if (lumaSlug && o.includes(lumaSlug)) return true;
  }

  // Fallback: same day + title fuzzy match
  const lumaDate = new Date(lumaEvt.start_time);
  const ourDate = new Date(ourEvt.start_time);
  if (isNaN(lumaDate) || isNaN(ourDate)) return false;
  if (lumaDate.toDateString() !== ourDate.toDateString()) return false;

  const lumaNorm = (lumaEvt.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ourNorm = (ourEvt.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!lumaNorm || !ourNorm) return false;
  if (lumaNorm === ourNorm) return true;
  if (lumaNorm.length > 10 && ourNorm.includes(lumaNorm.substring(0, 15))) return true;
  if (ourNorm.length > 10 && lumaNorm.includes(ourNorm.substring(0, 15))) return true;
  return false;
}

export async function checkCoverage() {
  let lumaEvents = [];
  let fetchError = null;
  try {
    lumaEvents = await fetchLumaAustinEvents();
  } catch (e) {
    fetchError = e.message;
  }

  const ourEvents = await fetchOurEvents();

  if (fetchError) {
    return {
      status: 'error',
      error: `Luma fetch failed: ${fetchError}`,
      events_on_luma: null,
      events_in_db: ourEvents.length,
      coverage_percentage: null,
      alert: true,
      reason: `Could not reach luma.com/austin — watchdog coverage check failed. May be Luma rate-limiting or a structure change.`,
    };
  }

  // Filter Luma events to AI-related only
  const aiLumaEvents = lumaEvents.filter(e => isAIRelated(e.title));

  // For each AI Luma event, check if it's in our DB
  const matched = [];
  const gaps = [];
  for (const lumaEvt of aiLumaEvents) {
    const hit = ourEvents.find(oe => eventsMatch(lumaEvt, oe));
    if (hit) {
      matched.push(lumaEvt);
    } else {
      gaps.push({
        title: lumaEvt.title,
        start_time: lumaEvt.start_time,
        url: lumaEvt.url,
      });
    }
  }

  const coveragePercentage = aiLumaEvents.length > 0
    ? Math.round((matched.length / aiLumaEvents.length) * 100)
    : null;

  let status = 'healthy';
  let alert = false;
  if (coveragePercentage !== null && coveragePercentage < 50) {
    status = 'degraded';
    alert = true;
  }

  return {
    status,
    events_on_luma: lumaEvents.length,
    ai_events_on_luma: aiLumaEvents.length,
    events_in_db: ourEvents.length,
    matched_count: matched.length,
    coverage_percentage: coveragePercentage,
    gaps,
    alert,
    reason: coveragePercentage === null
      ? `No AI-related events found on luma.com/austin in the next ${LOOKAHEAD_DAYS} days`
      : `Coverage ${coveragePercentage}%: ${matched.length}/${aiLumaEvents.length} AI events on Luma are in our DB${gaps.length ? ` (${gaps.length} gaps)` : ''}`,
  };
}

// CLI entry point: node scripts/coverage.js
const isDirectRun = process.argv[1] && process.argv[1].endsWith('coverage.js');
if (isDirectRun) {
  checkCoverage()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (result.alert) {
        console.error(`\n⚠️  COVERAGE ALERT: ${result.reason}`);
        process.exit(1);
      }
      console.log(`\n✅ Coverage check: ${result.reason}`);
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Coverage check failed:', error.message);
      process.exit(2);
    });
}
