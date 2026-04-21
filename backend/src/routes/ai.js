import { Router } from 'express';
import { ERROR_CODES, sendError } from '../httpError.js';

const router = Router();
const HOST_AI_URL = process.env.HOST_AI_URL || 'http://host.docker.internal:3002';
const AI_SHARED_SECRET = process.env.AI_SHARED_SECRET || '';
const AI_TIMEOUT_MS = 70000;
const AI_UNAVAILABLE_MESSAGE =
  'AI server is not running. Start it with: cd ai-server && node server.js';

async function callAi(path, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (AI_SHARED_SECRET) headers['X-AI-Secret'] = AI_SHARED_SECRET;
  const r = await fetch(`${HOST_AI_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = new Error(data.error || `AI server returned ${r.status}`);
    err.code = ERROR_CODES.AI_SERVER_ERROR;
    throw err;
  }
  return r.json();
}

function sendAiError(res, err, label) {
  console.error(`${label} failed:`, err.message);
  if (err.code === ERROR_CODES.AI_SERVER_ERROR) {
    return sendError(res, 503, ERROR_CODES.AI_SERVER_ERROR, err.message);
  }
  sendError(res, 503, ERROR_CODES.AI_SERVER_UNAVAILABLE, AI_UNAVAILABLE_MESSAGE);
}

router.post('/api/ai/summarize', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return sendError(res, 400, ERROR_CODES.INVALID_REQUEST, 'text is required');
  }

  try {
    const data = await callAi('/summarize', { text });
    res.json(data);
  } catch (err) {
    sendAiError(res, err, 'AI summarize');
  }
});

router.get('/api/ai/status', async (_req, res) => {
  try {
    const headers = {};
    if (AI_SHARED_SECRET) headers['X-AI-Secret'] = AI_SHARED_SECRET;
    const r = await fetch(`${HOST_AI_URL}/status`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      return sendError(
        res,
        503,
        ERROR_CODES.AI_SERVER_ERROR,
        data.error || `AI server returned ${r.status}`,
      );
    }
    res.json(await r.json());
  } catch (err) {
    console.error('AI status fetch failed:', err.message);
    sendError(res, 503, ERROR_CODES.AI_SERVER_UNAVAILABLE, AI_UNAVAILABLE_MESSAGE);
  }
});

router.put('/api/ai/config', async (req, res) => {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (AI_SHARED_SECRET) headers['X-AI-Secret'] = AI_SHARED_SECRET;
    const r = await fetch(`${HOST_AI_URL}/config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return sendError(
        res,
        r.status === 400 ? 400 : 503,
        ERROR_CODES.AI_SERVER_ERROR,
        data.error || `AI server returned ${r.status}`,
      );
    }
    res.json(data);
  } catch (err) {
    console.error('AI config update failed:', err.message);
    sendError(res, 503, ERROR_CODES.AI_SERVER_UNAVAILABLE, AI_UNAVAILABLE_MESSAGE);
  }
});

router.post('/api/ai/summarize-pr', async (req, res) => {
  const { title, body, files } = req.body;
  if (!title) {
    return sendError(res, 400, ERROR_CODES.INVALID_REQUEST, 'title is required');
  }

  const safeFiles = Array.isArray(files)
    ? files
        .filter((f) => f && typeof f.filename === 'string')
        .slice(0, 200)
        .map((f) => ({
          filename: f.filename,
          additions: Number.isFinite(f.additions) ? f.additions : 0,
          deletions: Number.isFinite(f.deletions) ? f.deletions : 0,
        }))
    : [];

  try {
    const data = await callAi('/summarize-pr', { title, body: body || '', files: safeFiles });
    res.json(data);
  } catch (err) {
    sendAiError(res, err, 'AI summarize-pr');
  }
});

export default router;
