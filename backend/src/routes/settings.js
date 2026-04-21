import { Router } from 'express';
import * as store from '../store.js';
import * as cache from '../cache.js';
import * as detailCache from '../detailCache.js';
import { ERROR_CODES, sendError } from '../httpError.js';

const router = Router();

router.get('/api/settings', async (_req, res) => {
  const settings = await store.getSettings();
  res.json(settings);
});

router.put('/api/settings', async (req, res) => {
  const { pollInterval } = req.body;

  if (pollInterval !== undefined) {
    if (typeof pollInterval !== 'number' || pollInterval < 15 || pollInterval > 3600) {
      return sendError(res, 400, ERROR_CODES.INVALID_REQUEST, 'pollInterval must be between 15 and 3600');
    }
  }

  const update = {};
  if (pollInterval !== undefined) update.pollInterval = pollInterval;
  const settings = await store.updateSettings(update);
  cache.setTTL(settings.pollInterval);
  detailCache.setTTL(settings.pollInterval);
  console.log(`Settings: pollInterval updated to ${settings.pollInterval}s`);
  res.json({ status: 'ok', settings });
});

export default router;
