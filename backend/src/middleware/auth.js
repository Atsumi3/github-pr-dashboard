import * as cache from '../cache.js';
import * as detailCache from '../detailCache.js';
import { ERROR_CODES, sendError } from '../httpError.js';
import { tokenHash } from '../tokenHash.js';

const TOKEN_HEADER = 'x-github-token';

// Endpoints that don't require GitHub token
const PUBLIC_PATHS = new Set(['/api/health']);

// Single-tenant: we remember the hash of the most recently seen token and,
// on change, drop both caches. Living in auth (rather than a separate
// cache-invalidation layer) is intentional — token boundaries are precisely
// the trust boundary the cache is scoped to, and the only signal the cache
// has for "different identity" is the token-presenting middleware.
let lastTokenHash = null;

export function authMiddleware() {
  return (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();

    const token = req.headers[TOKEN_HEADER];
    if (!token || typeof token !== 'string') {
      return sendError(res, 401, ERROR_CODES.INVALID_TOKEN, 'X-GitHub-Token header is required');
    }

    const h = tokenHash(token);
    if (lastTokenHash && lastTokenHash !== h) {
      cache.clear();
      detailCache.clear();
      console.log('Token changed — cleared PR list and detail caches');
    }
    lastTokenHash = h;

    req.token = token;
    next();
  };
}
