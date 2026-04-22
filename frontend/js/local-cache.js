// Lightweight localStorage cache for the last successful API responses
// (`me`, `repos`, `prs`). Read-on-init lets the dashboard repaint instantly
// after a hard reload while a fresh API call runs in the background — without
// this, hard-reload + slow network shows an empty page until /api/prs returns.
//
// Storage keys are prefixed `dash:` and JSON-encode `{ at: ms, data: ... }`.
// TTL is enforced at read time so users never see truly ancient data; quota
// errors are non-fatal (we just skip the write).

const KEY_PREFIX = 'dash:';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour for low-churn keys

// PR list moves quickly (poll every 60 s on the server). 15 min strikes a
// balance: fresh enough that paintFromCache after a short away doesn't show
// truly old data, while still surviving an offline reload.
const PRS_TTL_MS = 15 * 60 * 1000;

export const CACHE_KEYS = Object.freeze({
  me: 'me',
  repos: 'repos',
  prs: 'prs',
});

const TTL_BY_KEY = Object.freeze({
  prs: PRS_TTL_MS,
});

function storageKey(key) {
  return `${KEY_PREFIX}${key}`;
}

export function readCache(key, ttlMs = TTL_BY_KEY[key] ?? DEFAULT_TTL_MS) {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > ttlMs) return null;
    return { data: parsed.data, at: parsed.at };
  } catch {
    return null;
  }
}

export function writeCache(key, data) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify({ at: Date.now(), data }));
  } catch (err) {
    // QuotaExceededError or privacy-mode failure — log so this doesn't become
    // an invisible bug when the dashboard appears to "forget" between reloads.
    console.warn(`local-cache write skipped for ${key}:`, err?.name || err);
  }
}

export function clearCache(key) {
  try {
    localStorage.removeItem(storageKey(key));
  } catch {
    // ignore
  }
}

export function clearAllCaches() {
  for (const key of Object.values(CACHE_KEYS)) {
    clearCache(key);
  }
  clearAllAiSummaries();
}

// AI summary cache. Keyed by a per-PR (or per-thread) suffix so the user
// reopens a detail pane and sees their previous summary without re-spending
// CLI time. 7-day TTL acts as an upper bound; users can regenerate manually
// to refresh.
const AI_KEY_PREFIX = `${KEY_PREFIX}ai:`;
const AI_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function readAiSummary(suffix) {
  try {
    const raw = localStorage.getItem(AI_KEY_PREFIX + suffix);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== 'number' || typeof parsed.summary !== 'string') return null;
    if (Date.now() - parsed.at > AI_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAiSummary(suffix, summary, cli) {
  try {
    localStorage.setItem(
      AI_KEY_PREFIX + suffix,
      JSON.stringify({ at: Date.now(), summary, cli: cli || null }),
    );
  } catch (err) {
    console.warn(`AI cache write skipped for ${suffix}:`, err?.name || err);
  }
}

export function clearAllAiSummaries() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(AI_KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}
