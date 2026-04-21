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

app.use(express.json());
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
