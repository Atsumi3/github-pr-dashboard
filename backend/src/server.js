import express from 'express';
import { authMiddleware } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import reposRoutes from './routes/repos.js';
import prsRoutes from './routes/prs.js';
import settingsRoutes from './routes/settings.js';
import aiRoutes from './routes/ai.js';
import * as store from './store.js';
import * as cache from './cache.js';
import * as detailCache from './detailCache.js';
import { ERROR_CODES, sendError } from './httpError.js';

const PORT = process.env.PORT || 3001;
const app = express();

// Defence-in-depth against cross-origin abuse. The X-GitHub-Token header
// requirement already forces a CORS preflight for cross-origin fetches, but
// this guard fails closed even if a future change accidentally relaxes the
// CORS surface. Only the configured frontend origin (defaulting to localhost
// nginx) and explicit no-Origin/no-Referer calls (CLIs, SW fetches with no
// Referer policy) are accepted.
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function originGuard(req, res, next) {
  if (req.path === '/api/health') return next();
  const origin = req.headers.origin;
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return sendError(res, 403, ERROR_CODES.INVALID_REQUEST, 'forbidden origin');
    }
    return next();
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      const u = new URL(referer);
      if (!ALLOWED_ORIGINS.has(u.origin)) {
        return sendError(res, 403, ERROR_CODES.INVALID_REQUEST, 'forbidden referer');
      }
    } catch {
      return sendError(res, 403, ERROR_CODES.INVALID_REQUEST, 'invalid referer');
    }
  }
  // No Origin and no Referer: same-origin fetch from a navigation context, a
  // CLI, or a curl. Token check still gates these requests.
  next();
}

app.use(express.json());
app.use(originGuard);
app.use(authMiddleware());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(authRoutes);
app.use(reposRoutes);
app.use(prsRoutes);
app.use(settingsRoutes);
app.use(aiRoutes);

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, 'An unexpected error occurred');
});

app.listen(PORT, async () => {
  console.log(`Backend listening on port ${PORT}`);

  const settings = await store.getSettings();
  cache.setTTL(settings.pollInterval);
  detailCache.setTTL(settings.pollInterval);
});

process.on('SIGTERM', () => {
  process.exit(0);
});
