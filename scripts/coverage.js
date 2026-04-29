/**
 * Coverage ground truth — counts AI events visible on the watchdog's
 * reference platforms (Luma + Meetup find) for a given city, and reports
 * a single combined number alongside the agent's own DB count.
 *
 * Design principle (2026-04-29 reset):
 * The watchdog returns ONLY counts. No event titles, no per-platform
 * breakdown, no gap lists, no specific URLs. The agent must not be told
 * the answers — only whether it is hitting the platform ceiling.
 *
 * Independence: this duplicates a small amount of platform-parsing logic
 * from the main repo so the watchdog is fully isolated. If the main repo's
 * Luma or Meetup parsers break, this watchdog's parsers still work, and
 * that's the point.
 */

import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import { fetchMeetupFindEvents } from './meetupFind.js';

// MUST match LOOKAHEAD_DAYS in meetupFind.js + liveness.js + run.js writeAuditRow.
// 30 = match the frontend calendar window (what users actually see).
const LOOKAHEAD_DAYS = 30;

// Per-city watchdog references. Luma city aggregator + Meetup find search.
// Both must be strict supersets of the city's config sources — never
// config sources themselves — otherwise the comparison is circular.
//
// luma.com/<slug> is the natural city aggregator (noisy, AI filter handles
// it). Meetup find is a topic+city search across all groups, also a
// strict superset by construction.
const CITY_REFERENCES = {
  austin: {
    luma_url: 'https://luma.com/austin',
    meetup_find: { state: 'tx', city: 'Austin' },
  },
  sf: {
    luma_url: 'https://luma.com/sf',
    meetup_find: { state: 'ca', city: 'San Francisco' },
  },
};

/**
 * Filter a combined list of events to AI-related ones via a single Haiku call.
 * One batched call per audit (~30-50 titles) → ~$0.001/audit on Haiku 4.5.
 *
 * Independence note: this uses a different prompt and code path than the
 * agent's validator, so the watchdog still catches scraper/parser/pipeline
 * bugs in the agent.
 */
async function filterAIEvents(events) {
  if (events.length === 0) return [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for the AI filter');
  }
  const client = new Anthropic({ apiKey });

  const numbered = events.map((e, i) => `${i}: ${e.title}`).join('\n');
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You filter event titles for an AI-events calendar. For each numbered title, decide if it's about artificial intelligence, machine learning, LLMs, AI tools/agents/products, or AI builder communities. Exclude general tech, business, social, or non-AI topics.

Titles:
${numbered}

Return ONLY a JSON array of the indices that ARE AI-related — no prose, no explanation. Example: [0, 2, 5]`,
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim() ?? '';
  const arrayMatch = text.match(/\[[\d,\s]*\]/);
  if (!arrayMatch) {
    throw new Error(`Haiku returned non-array response: ${text.slice(0, 200)}`);
  }
  const indices = JSON.parse(arrayMatch[0]);
  return indices.map(i => events[i]).filter(Boolean);
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

  const nextDataScript = $('script#__NEXT_DATA__').html();
  if (!nextDataScript) {
    throw new Error('Luma page has no __NEXT_DATA__ script');
  }

  let nextData;
  try {
    nextData = JSON.parse(nextDataScript);
  } catch (e) {
    throw new Error(`Failed to parse Luma __NEXT_DATA__: ${e.message}`);
  }

  const pageProps = nextData?.props?.pageProps || nextData?.pageProps;
  const entries = pageProps?.initialData?.events
    || pageProps?.initialData?.data?.events
    || [];

  if (!Array.isArray(entries)) {
    throw new Error('Luma pageProps.initialData.events is not an array');
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

    events.push({
      title: evt.name,
      start_time: evt.start_at,
    });
  }

  return events;
}

/**
 * Count agent's own events for the city in the lookahead window.
 * The watchdog reads this from the same DB the agent writes to —
 * it's the agent's own data echoed back, not external information.
 */
async function fetchOurEventsCount(city) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  }

  const supabase = createClient(supabaseUrl, anonKey);
  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  const { count, error } = await supabase
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('city', city)
    .is('deleted_at', null)
    .gte('start_time', now.toISOString())
    .lte('start_time', horizon.toISOString());

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }
  return count ?? 0;
}

export async function checkCoverage(city = 'austin') {
  const ref = CITY_REFERENCES[city];
  if (!ref) {
    return {
      status: 'error',
      city,
      events_in_db: null,
      events_seen: null,
      alert: true,
      reason: `No CITY_REFERENCES entry for city=${city}`,
    };
  }

  const [lumaResult, meetupResult, dbResult] = await Promise.allSettled([
    fetchLumaEvents(ref.luma_url),
    fetchMeetupFindEvents(ref.meetup_find.state, ref.meetup_find.city),
    fetchOurEventsCount(city),
  ]);

  // DB failure is fatal — without our own count, comparison is meaningless
  if (dbResult.status === 'rejected') {
    return {
      status: 'error',
      city,
      events_in_db: null,
      events_seen: null,
      alert: true,
      reason: `DB count query failed: ${dbResult.reason.message}`,
    };
  }
  const eventsInDb = dbResult.value;

  const platformEvents = [];
  const fetchErrors = [];
  if (lumaResult.status === 'fulfilled') {
    platformEvents.push(...lumaResult.value);
  } else {
    fetchErrors.push(`luma: ${lumaResult.reason.message}`);
  }
  if (meetupResult.status === 'fulfilled') {
    platformEvents.push(...meetupResult.value);
  } else {
    fetchErrors.push(`meetup: ${meetupResult.reason.message}`);
  }

  if (platformEvents.length === 0 && fetchErrors.length === 2) {
    return {
      status: 'error',
      city,
      events_in_db: eventsInDb,
      events_seen: null,
      alert: true,
      reason: `All reference platforms failed: ${fetchErrors.join('; ')}`,
    };
  }

  let aiEvents;
  try {
    aiEvents = await filterAIEvents(platformEvents);
  } catch (e) {
    return {
      status: 'error',
      city,
      events_in_db: eventsInDb,
      events_seen: null,
      alert: true,
      reason: `AI filter failed: ${e.message}`,
    };
  }

  const eventsSeen = aiEvents.length;
  const partial = fetchErrors.length > 0 ? ` (partial: ${fetchErrors.join('; ')})` : '';

  return {
    status: 'healthy',
    city,
    events_in_db: eventsInDb,
    events_seen: eventsSeen,
    alert: false,
    reason: `events_in_db=${eventsInDb}, events_seen=${eventsSeen}${partial}`,
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
