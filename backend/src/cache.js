let cached = null;
let cachedAt = 0;
let version = 0;
let ttl = 300_000;

export function get() {
  if (cached && Date.now() - cachedAt < ttl) {
    return cached;
  }
  return null;
}

// Read the last-stored snapshot ignoring TTL. Used by fetchAllPRs when it
// needs to preserve per-repo PR lists across a transient failure: TTL is for
// "is this fresh enough to skip a fetch?", not for "is this still better than
// nothing if the next fetch fails?".
export function peek() {
  return cached;
}

export function set(data) {
  cached = data;
  cachedAt = Date.now();
  version++;
}

export function clear() {
  cached = null;
  cachedAt = 0;
  version++;
}

export function upsertRepo(repoId, repoData) {
  // Update a single repo entry without touching cachedAt — partial updates
  // must not claim "the whole snapshot was refreshed at this time".
  // The internal array order is intentionally unstable here; consumers must
  // re-order against the watched list (see buildResponse in routes/prs.js).
  if (!cached) return;
  const next = cached.filter((r) => r.repo !== repoId);
  next.push(repoData);
  cached = next;
  version++;
}

// Monotonic counter bumped on every mutation. Consumers that build derived
// views (e.g. buildResponse) can memoize keyed by this version.
export function getVersion() {
  return version;
}

export function setTTL(seconds) {
  ttl = seconds * 1000;
}

export function getUpdatedAt() {
  // TTL is enforced by get(); callers that read this value have a fresh snapshot.
  return cachedAt ? new Date(cachedAt).toISOString() : null;
}
