import { createHash } from 'node:crypto';

// Hash GitHub PATs before using them as cache keys / change-detection keys.
// We never want the verbatim token to live in long-lived data structures
// (heap dumps, debug logs) when an opaque hash works just as well.
export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}
