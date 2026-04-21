import { ERROR_CODES, sendError } from '../httpError.js';

const TOKEN_HEADER = 'x-github-token';

// Endpoints that don't require GitHub token
const PUBLIC_PATHS = new Set(['/api/health']);

export function authMiddleware() {
  return (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();

    const token = req.headers[TOKEN_HEADER];
    if (!token || typeof token !== 'string') {
      return sendError(res, 401, ERROR_CODES.INVALID_TOKEN, 'X-GitHub-Token header is required');
    }

    req.token = token;
    next();
  };
}
