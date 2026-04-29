/**
 * Meetup find search parser — fetches meetup.com/find/?keywords=AI&location=...
 * and extracts events from the __APOLLO_STATE__ blob in __NEXT_DATA__.
 *
 * Independent implementation — does NOT import from the main repo. If the
 * main system's Meetup parser breaks, this watchdog parser still works.
 *
 * Returns events in the same shape as fetchLumaEvents: {title, start_time, url}.
 */

// MUST match LOOKAHEAD_DAYS in coverage.js + liveness.js + run.js writeAuditRow.
const LOOKAHEAD_DAYS = 30;

function buildFindUrl(stateCode, cityName) {
  const state = stateCode.toLowerCase();
  const city = encodeURIComponent(cityName).replace(/%20/g, '+');
  return `https://www.meetup.com/find/?keywords=AI&location=us--${state}--${city}`;
}

export async function fetchMeetupFindEvents(stateCode, cityName) {
  const url = buildFindUrl(stateCode, cityName);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Meetup find fetch failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error('Meetup find page has no __NEXT_DATA__ script');
  }

  let nextData;
  try {
    nextData = JSON.parse(match[1]);
  } catch (e) {
    throw new Error(`Failed to parse __NEXT_DATA__: ${e.message}`);
  }

  const apollo = nextData?.props?.pageProps?.__APOLLO_STATE__;
  if (!apollo || !apollo.ROOT_QUERY) {
    throw new Error('Meetup find __APOLLO_STATE__.ROOT_QUERY missing');
  }

  const searchKey = Object.keys(apollo.ROOT_QUERY).find(k => k.startsWith('eventSearch'));
  if (!searchKey) {
    return [];
  }

  const edges = apollo.ROOT_QUERY[searchKey].edges;
  if (!Array.isArray(edges)) {
    return [];
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const events = [];

  for (const edge of edges) {
    const ref = edge.node?.__ref;
    if (!ref) continue;
    const ev = apollo[ref];
    if (!ev || !ev.title || !ev.dateTime) continue;

    const startDate = new Date(ev.dateTime);
    if (isNaN(startDate)) continue;
    if (startDate < now || startDate > horizon) continue;

    events.push({
      title: ev.title,
      start_time: ev.dateTime,
      url: ev.eventUrl || null,
    });
  }

  return events;
}
