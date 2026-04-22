// PR detail cache: per-PR with TTL + size limit (LRU-like via Map insertion order)
const MAX_ENTRIES = 200;
let ttlMs = 300_000;

const store = new Map(); // key -> { data, fetchedAt }

export function setTTL(seconds) {
  ttlMs = seconds * 1000;
}

function makeKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

export function get(owner, repo, number) {
  const key = makeKey(owner, repo, number);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttlMs) {
    store.delete(key);
    return null;
  }
  // Refresh insertion order for LRU behavior
  store.delete(key);
  store.set(key, entry);
  return entry.data;
}

export function set(owner, repo, number, data) {
  const key = makeKey(owner, repo, number);
  store.delete(key);
  store.set(key, { data, fetchedAt: Date.now() });
  // Evict oldest if over limit
  while (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
  }
}

export function clear() {
  store.clear();
}
