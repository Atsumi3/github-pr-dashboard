// Lightweight localStorage cache for the last successful API responses
// (`me`, `repos`, `prs`). Read-on-init lets the dashboard repaint instantly
// after a hard reload while a fresh API call runs in the background — without
// this, hard-reload + slow network shows an empty page until /api/prs returns.
//
// Storage keys are prefixed `dash:` and JSON-encode `{ at: ms, data: ... }`.
// TTL is enforced at read time so users never see truly ancient data; quota
// errors are non-fatal (we just skip the write).

const KEY_PREFIX = 'dash:';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export const CACHE_KEYS = Object.freeze({
  me: 'me',
  repos: 'repos',
  prs: 'prs',
});

function storageKey(key) {
  return `${KEY_PREFIX}${key}`;
}

export function readCache(key, ttlMs = DEFAULT_TTL_MS) {
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
  } catch {
    // QuotaExceededError or privacy-mode failure — silently skip; the next
    // successful poll will repopulate from a smaller payload.
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
}
