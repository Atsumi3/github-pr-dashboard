// Centralized error response shape: { error: { code, message } }.
// All routes should use sendError instead of building this object inline.

export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_TOKEN: 'INVALID_TOKEN',
  REPO_NOT_FOUND: 'REPO_NOT_FOUND',
  REPO_ALREADY_EXISTS: 'REPO_ALREADY_EXISTS',
  GITHUB_TOKEN_EXPIRED: 'GITHUB_TOKEN_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  AI_SERVER_ERROR: 'AI_SERVER_ERROR',
  AI_SERVER_UNAVAILABLE: 'AI_SERVER_UNAVAILABLE',
});

export function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// GitHub REST/GraphQL errors → our HTTP status + code. Centralised so route
// handlers don't each invent their own mapping.
export function mapGithubError(err) {
  if (err && err.status === 401) {
    return {
      status: 401,
      code: ERROR_CODES.GITHUB_TOKEN_EXPIRED,
      message: 'GitHub token is invalid',
    };
  }
  if (err && err.status === 403) {
    return {
      status: 429,
      code: ERROR_CODES.RATE_LIMITED,
      message: 'GitHub API rate limit exceeded',
    };
  }
  return null;
}
