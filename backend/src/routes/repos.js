import { Router } from 'express';
import * as store from '../store.js';
import * as github from '../github.js';
import { ERROR_CODES, sendError, mapGithubError } from '../httpError.js';
import { parseRepoId, validateOwnerName } from '../repoId.js';

const router = Router();

router.get('/api/repos', async (_req, res) => {
  const repos = await store.getRepos();
  res.json({ repos });
});

router.post('/api/repos', async (req, res) => {
  const parsed = parseRepoId(req.body?.repo);
  if (!parsed) {
    return sendError(res, 400, ERROR_CODES.INVALID_REQUEST, 'repo must be in owner/name format');
  }

  const exists = await github.verifyRepo(req.token, parsed.owner, parsed.name);
  if (!exists) {
    return sendError(
      res,
      404,
      ERROR_CODES.REPO_NOT_FOUND,
      `Repository ${parsed.id} not found or inaccessible`,
    );
  }

  const added = await store.addRepo(parsed.id);
  if (!added) {
    return sendError(
      res,
      409,
      ERROR_CODES.REPO_ALREADY_EXISTS,
      `Repository ${parsed.id} is already in the watch list`,
    );
  }

  console.log(`Repos: added ${parsed.id}`);
  res.status(201).json({ status: 'ok', repo: added });
});

router.patch('/api/repos/:owner/:name', async (req, res) => {
  const { owner, name } = req.params;
  if (!validateOwnerName(owner, name)) {
    return sendError(
      res,
      400,
      ERROR_CODES.INVALID_REQUEST,
      'owner and name must match ^[A-Za-z0-9_.-]+$',
    );
  }
  const id = `${owner}/${name}`;
  const { paused } = req.body;
  if (typeof paused !== 'boolean') {
    return sendError(res, 400, ERROR_CODES.INVALID_REQUEST, 'paused must be boolean');
  }
  const ok = await store.setRepoPaused(id, paused);
  if (!ok) {
    return sendError(
      res,
      404,
      ERROR_CODES.REPO_NOT_FOUND,
      `Repository ${id} is not in the watch list`,
    );
  }
  console.log(`Repos: ${id} paused=${paused}`);
  res.json({ status: 'ok', repo: { id, paused } });
});

router.delete('/api/repos/:owner/:name', async (req, res) => {
  const { owner, name } = req.params;
  if (!validateOwnerName(owner, name)) {
    return sendError(
      res,
      400,
      ERROR_CODES.INVALID_REQUEST,
      'owner and name must match ^[A-Za-z0-9_.-]+$',
    );
  }
  const id = `${owner}/${name}`;
  const removed = await store.removeRepo(id);
  if (!removed) {
    return sendError(
      res,
      404,
      ERROR_CODES.REPO_NOT_FOUND,
      `Repository ${id} is not in the watch list`,
    );
  }
  console.log(`Repos: removed ${id}`);
  res.json({ status: 'ok' });
});

router.get('/api/repos/suggestions', async (req, res) => {
  try {
    const user = await github.getUser(req.token);
    console.log(`Suggestions: scanning repos for ${user.login}`);
    const watched = await store.getRepos();
    const watchedIds = new Set(watched.map((r) => r.id));
    const suggestions = await github.suggestRepos(req.token, user.login);
    const items = suggestions.map((s) => ({
      ...s,
      alreadyWatched: watchedIds.has(s.repo),
    }));
    res.json({ items });
  } catch (err) {
    console.error('Suggestions: failed', err.message);
    const mapped = mapGithubError(err);
    if (mapped) return sendError(res, mapped.status, mapped.code, mapped.message);
    return sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, 'Failed to scan repositories');
  }
});

router.get('/api/repos/search', async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return sendError(res, 400, ERROR_CODES.INVALID_REQUEST, 'q parameter is required');
  }

  try {
    const [userItems, searchItems] = await Promise.all([
      github.listUserRepos(req.token, q),
      github.searchRepos(req.token, q).catch(() => []),
    ]);

    const seen = new Set();
    const items = [];
    for (const item of [...userItems, ...searchItems]) {
      if (!seen.has(item.fullName)) {
        seen.add(item.fullName);
        items.push(item);
      }
    }

    res.json({ items: items.slice(0, 20) });
  } catch (err) {
    const mapped = mapGithubError(err);
    if (mapped) return sendError(res, mapped.status, mapped.code, mapped.message);
    throw err;
  }
});

export default router;
