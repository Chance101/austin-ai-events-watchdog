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

// Per-city Luma reference URL. The watchdog compares our DB against this
// public Luma calendar to detect coverage drops. **Reference must be a strict
// superset of the city's config sources, never a config source itself** —
// otherwise the comparison is circular and can't catch missed sources,
// throttling, or coverage gaps. City aggregators (luma.com/<slug>) are the
// natural superset: noisy, but the AI_KEYWORDS filter handles that, and they
// stay outside config by design (too noisy to auto-trust). Curator calendars
// like luma.com/genai-sf are config sources by construction, so they fail
// this test — initial SF reference 2026-04-26 was genai-sf and was found to
// produce events_on_luma=0 for circular reasons (parser mismatch surfaced
// it; the deeper issue is the principle violation). Switched to luma.com/sf
// 2026-04-29. Treat coverage% as a side metric; the actionable signal is
// the gap list (events watchdog finds that aren't in DB).
const CITY_LUMA_URLS = {
  austin: 'https://luma.com/austin',
  sf: 'https://luma.com/sf',
};

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
 * Fetch a city's reference Luma calendar and extract events from __NEXT_DATA__.
 * Independent copy of the relevant extraction logic — NOT an import
 * from the main repo (that would defeat the isolation purpose).
 */
async function fetchLumaEvents(lumaUrl) {
  const response = await fetch(lumaUrl, {
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
 * Fetch our Supabase events in the lookahead window for a specific city.
 */
async function fetchOurEvents(city) {
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
    .eq('city', city)
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

export async function checkCoverage(city = 'austin') {
  const lumaUrl = CITY_LUMA_URLS[city];
  if (!lumaUrl) {
    return {
      status: 'error',
      city,
      error: `No Luma reference URL configured for city=${city}`,
      events_on_luma: null,
      events_in_db: null,
      coverage_percentage: null,
      alert: true,
      reason: `Add CITY_LUMA_URLS["${city}"] in coverage.js`,
    };
  }

  let lumaEvents = [];
  let fetchError = null;
  try {
    lumaEvents = await fetchLumaEvents(lumaUrl);
  } catch (e) {
    fetchError = e.message;
  }

  const ourEvents = await fetchOurEvents(city);

  if (fetchError) {
    return {
      status: 'error',
      city,
      error: `Luma fetch failed: ${fetchError}`,
      events_on_luma: null,
      events_in_db: ourEvents.length,
      coverage_percentage: null,
      alert: true,
      reason: `Could not reach ${lumaUrl} — watchdog coverage check failed. May be Luma rate-limiting or a structure change.`,
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
    city,
    luma_url: lumaUrl,
    events_on_luma: lumaEvents.length,
    ai_events_on_luma: aiLumaEvents.length,
    events_in_db: ourEvents.length,
    matched_count: matched.length,
    coverage_percentage: coveragePercentage,
    gaps,
    alert,
    reason: coveragePercentage === null
      ? `No AI-related events found on ${lumaUrl} in the next ${LOOKAHEAD_DAYS} days`
      : `Coverage ${coveragePercentage}%: ${matched.length}/${aiLumaEvents.length} AI events on Luma are in our DB for ${city}${gaps.length ? ` (${gaps.length} gaps)` : ''}`,
  };
}

// CLI entry point: node scripts/coverage.js
const isDirectRun = process.argv[1] && process.argv[1].endsWith('coverage.js');
if (isDirectRun) {
  const city = process.env.CITY || 'austin';
  checkCoverage(city)
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
