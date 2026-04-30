// Why: ADSBdb / AeroAPI / adsb.lol all return null `registeredOwner` for
// some currently-active aircraft (especially law-enforcement helicopters
// like N818PD which fly KBUR↔KBUR loops). The FAA's bulk download
// (ReleasableAircraft.zip) is currently shipping a partial MASTER.txt
// that excludes most of these. But the FAA's *web* aircraft inquiry at
// registry.faa.gov has the full data, including the owner — we just have
// to scrape it. Per-tail HTTP fetch with aggressive caching + throttling
// keeps us a polite citizen on FAA's end and bounds latency on ours.

const FAA_INQUIRY_URL = "https://registry.faa.gov/aircraftinquiry/Search/NNumberResult";
const USER_AGENT =
  "flight-tracker/0.1 (personal use; FAA registry owner-name fallback)";
// Why: owner data changes on transfer-of-registration timescales (months
// to years). 24h is plenty fresh; cuts FAA traffic to ~1 hit per N-number
// per day even for the most-watched aircraft.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Why: negative results (not found / parse failure) get a shorter TTL
// so we recover quickly if FAA fixes a record we missed, without
// hammering them on every poll for genuinely-unregistered N-numbers.
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const REQUEST_TIMEOUT_MS = 8000;
// Why: serialize requests + minimum interval = max ~5 req/sec to FAA.
// Their server handles way more than that, but we have no agreement with
// them and the polite floor is generous.
const MIN_REQUEST_INTERVAL_MS = 200;

type CacheEntry = { value: string | null; fetchedAt: number; ttl: number };
const cache = new Map<string, CacheEntry>();

let lastRequestPromise: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function isCacheFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < entry.ttl;
}

// Why: synchronous cache read so the main /api/flights route can return
// immediately with whatever's already known, without waiting on any FAA
// call. Pair with `backfillFaaOwnerAsync` to populate the cache for the
// next poll.
export function getCachedFaaOwner(callsign: string): string | null {
  const normalized = normalizeNNumber(callsign);
  if (!normalized) return null;
  const entry = cache.get(normalized);
  if (!entry || !isCacheFresh(entry)) return null;
  return entry.value;
}

export function backfillFaaOwnerAsync(callsign: string): void {
  // Fire-and-forget. lookupFaaOwner internally guards against duplicate
  // in-flight requests via the cache + queue.
  void lookupFaaOwner(callsign).catch(() => {
    // Swallow — failures are stored as negative cache entries inside the
    // lookup. We don't want background errors to bubble.
  });
}

export async function lookupFaaOwner(callsign: string): Promise<string | null> {
  const normalized = normalizeNNumber(callsign);
  if (!normalized) return null;

  const cached = cache.get(normalized);
  if (cached && isCacheFresh(cached)) {
    return cached.value;
  }

  // Serialize all pending requests through a single chain so the
  // MIN_REQUEST_INTERVAL_MS throttle holds across concurrent callers.
  const myTurn = lastRequestPromise.then(async () => {
    const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fetchAndParse(normalized);
  });
  // Replace with a swallowed copy so a single failure doesn't poison the chain
  // for subsequent callers.
  lastRequestPromise = myTurn.catch(() => undefined);

  try {
    const value = await myTurn;
    const ttl = value == null ? NEGATIVE_CACHE_TTL_MS : CACHE_TTL_MS;
    cache.set(normalized, { value, fetchedAt: Date.now(), ttl });
    return value;
  } catch {
    // Network error / timeout / parse exception. Negative-cache so we don't
    // hammer FAA when their site is having a moment.
    cache.set(normalized, {
      value: null,
      fetchedAt: Date.now(),
      ttl: NEGATIVE_CACHE_TTL_MS
    });
    return null;
  }
}

function normalizeNNumber(callsign: string): string | null {
  const s = callsign.trim().toUpperCase();
  // Strip the leading "N" — FAA's registry keys on the bare number+suffix.
  const stripped = s.startsWith("N") ? s.slice(1) : s;
  // FAA N-number format: 1-5 digits then optional 1-2 trailing letters.
  // (The leading "N" we already stripped is the country code.)
  if (!/^\d{1,5}[A-Z]{0,2}$/.test(stripped)) return null;
  return stripped;
}

async function fetchAndParse(nNumber: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${FAA_INQUIRY_URL}?nNumberTxt=${nNumber}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: controller.signal,
      // Why: the FAA's server-side caching is fine; no point in our own
      // double-cache. We have our own cache layer above.
      cache: "no-store"
    });
    if (!response.ok) return null;
    const html = await response.text();
    return parseRegisteredOwner(html);
  } finally {
    clearTimeout(timeout);
  }
}

// Why: the FAA inquiry result page renders the owner inside a
// <table> immediately following <caption>Registered Owner</caption>.
// First <td data-label="Name"> after that caption holds the value.
// Match non-greedily so we don't cross into the "Other Owner Names"
// section (secondary registrations).
const REGISTERED_OWNER_PATTERN =
  /<caption[^>]*>\s*Registered Owner\s*<\/caption>[\s\S]*?<td[^>]*data-label="Name"[^>]*>([^<]+)</i;

function parseRegisteredOwner(html: string): string | null {
  const match = html.match(REGISTERED_OWNER_PATTERN);
  if (!match || !match[1]) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  // FAA pads names with trailing spaces in the released data; the inquiry
  // page inherits that formatting. Collapse any internal whitespace runs
  // into single spaces too while we're here.
  return raw.replace(/\s+/g, " ");
}
