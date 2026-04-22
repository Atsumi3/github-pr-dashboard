import { Router } from 'express';
import { createHash } from 'node:crypto';
import * as store from '../store.js';
import * as cache from '../cache.js';
import * as detailCache from '../detailCache.js';
import * as github from '../github.js';
import { ERROR_CODES, sendError } from '../httpError.js';

const router = Router();

// hash(token) -> { login, expiresAt } (10 min TTL, 200 entry cap).
// resolveMe is called on every /api/prs poll; caching avoids 1 GitHub /user call per minute per user.
// Tokens are hashed (not stored verbatim) so a heap dump never exposes credentials.
const ME_TTL_MS = 10 * 60 * 1000;
const ME_CACHE_MAX = 200;
const meCache = new Map();

function tokenKey(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Coalesce concurrent fetchAllPRs calls so that a thundering herd of cache-miss
// requests results in only one GraphQL fan-out.
// NOTE: This dashboard is designed for single-tenant local use (one GitHub
// identity per backend process). The inflight Promise and the global cache
// are deliberately not partitioned by token — that would be a no-op here and
// just add complexity. If multi-tenant deployment is ever attempted, both
// must be partitioned (e.g. keyed by sha256(token)) and the architecture
// reviewed end-to-end.
let inflightFetchAll = null;

export async function fetchAllPRs(token) {
  if (inflightFetchAll) return inflightFetchAll;
  inflightFetchAll = (async () => {
    const allRepos = await store.getRepos();
    // Intentionally do NOT clear cache when token/repos are missing — keep the
    // last good snapshot so a transient empty state doesn't wipe the dashboard.
    if (!token || allRepos.length === 0) return;

    const activeRepos = allRepos.filter((r) => !r.paused);
    if (activeRepos.length === 0) {
      console.log('Fetch: all repos paused, skipping');
      return;
    }

    console.log(
      `Fetch: fetching PRs for ${activeRepos.length}/${allRepos.length} repo(s) (others paused)`,
    );
    const previous = cache.get() || [];
    const previousByRepo = new Map(previous.map((r) => [r.repo, r]));
    const results = await Promise.all(
      activeRepos.map(async (repo) => {
        try {
          const prs = await github.fetchOpenPRs(token, repo.id);
          return { repo: repo.id, prs, error: null };
        } catch (err) {
          const detail = err.errors
            ? JSON.stringify(err.errors)
            : err.status
              ? `status=${err.status}`
              : '';
          console.error(
            `Fetch: failed to fetch ${repo.id}: ${err.message}${detail ? ' | ' + detail : ''}`,
          );
          // Preserve the previous successful PR list for this repo rather than
          // showing "Repository inaccessible" whenever GitHub returns a
          // transient 5xx. Users see slightly stale data instead of an empty
          // section until the next successful poll.
          const prev = previousByRepo.get(repo.id);
          // Carry the HTTP status so the frontend can distinguish "your token
          // can't see this repo" (4xx) from "GitHub itself is having a bad
          // moment" (5xx) — the previous generic "Repository inaccessible"
          // misled users into thinking they had a permission problem.
          return {
            repo: repo.id,
            prs: prev?.prs || [],
            error: { message: err.message, status: err.status || null },
          };
        }
      }),
    );

    const hasSuccess = results.some((r) => r.error === null);
    if (hasSuccess) {
      cache.set(results);
    } else {
      console.warn('Fetch: all repos failed, keeping previous cache');
    }
  })();

  try {
    return await inflightFetchAll;
  } finally {
    inflightFetchAll = null;
  }
}

function isRelatedToMe(pr, me) {
  if (pr.assignees.some((a) => a.login === me)) return true;
  if (pr.requestedReviewers && pr.requestedReviewers.some((r) => r.login === me)) return true;
  if (pr.reviews && pr.reviews.some((r) => r.login === me)) return true;
  if (pr.author && pr.author.login === me) return true;
  if (!pr.draft && pr.author?.login !== me && pr.reviewStatus === 'REVIEW_REQUIRED') return true;
  return false;
}

// Sorting is intentionally the frontend's responsibility — it owns the user-
// selectable sort key (status / updated / created / behind). The backend only
// filters by isRelatedToMe and returns PRs in their fetch order.

async function resolveMe(token, assigneeQuery) {
  if (assigneeQuery !== 'me' || !token) return null;
  const key = tokenKey(token);
  const cached = meCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    // Re-insert to refresh LRU position.
    meCache.delete(key);
    meCache.set(key, cached);
    return cached.login;
  }
  if (cached) meCache.delete(key);
  try {
    const user = await github.getUser(token);
    meCache.set(key, { login: user.login, expiresAt: Date.now() + ME_TTL_MS });
    if (meCache.size > ME_CACHE_MAX) {
      // Evict oldest (insertion-order Map).
      const oldestKey = meCache.keys().next().value;
      meCache.delete(oldestKey);
    }
    return user.login;
  } catch {
    // Don't poison the cache on transient failure — a stale entry would have
    // already been removed above if the TTL had elapsed. Keep silently failing
    // to null so the caller falls back to "everyone" filtering.
    return null;
  }
}

// Memoize the rendered response by (cache version, repos version, me).
// On a cache HIT this lets multiple polling clients share the same computed
// payload instead of re-running the watched-iteration + filter on every call.
let memoKey = null;
let memoValue = null;

async function buildResponse(data, me) {
  const key = `${cache.getVersion()}|${store.getReposVersion()}|${me || ''}`;
  if (key === memoKey && memoValue) return memoValue;

  const cachedRepos = data || [];
  const watched = await store.getRepos();
  const cachedById = new Map(cachedRepos.map((r) => [r.repo, r]));
  let repos = watched.map((w) => {
    const cached = cachedById.get(w.id);
    return {
      repo: w.id,
      paused: !!w.paused,
      prs: cached ? cached.prs : [],
      error: cached ? cached.error : null,
    };
  });
  if (me) {
    repos = repos.map((r) => ({
      ...r,
      prs: r.prs.filter((pr) => isRelatedToMe(pr, me)),
    }));
  }

  memoValue = { updatedAt: cache.getUpdatedAt(), repos };
  memoKey = key;
  return memoValue;
}

router.get('/api/prs', async (req, res) => {
  const me = await resolveMe(req.token, req.query.assignee);

  const data = cache.get();
  if (data) {
    return res.json(await buildResponse(data, me));
  }

  await fetchAllPRs(req.token);
  res.json(await buildResponse(cache.get() || [], me));
});

router.get('/api/prs/repo/:owner/:repo', async (req, res) => {
  const { owner, repo } = req.params;
  const me = await resolveMe(req.token, req.query.assignee);
  const repoId = `${owner}/${repo}`;

  try {
    const prs = await github.fetchOpenPRs(req.token, repoId);
    cache.upsertRepo(repoId, { repo: repoId, prs, error: null });

    const filteredPrs = me ? prs.filter((pr) => isRelatedToMe(pr, me)) : prs;
    res.json({ repo: repoId, prs: filteredPrs });
  } catch (err) {
    console.error(`Single repo fetch failed for ${repoId}:`, err.message);
    sendError(res, err.status || 500, ERROR_CODES.INTERNAL_ERROR, err.message);
  }
});

router.get('/api/prs/:owner/:repo/:number', async (req, res) => {
  const { owner, repo } = req.params;
  const number = parseInt(req.params.number, 10);

  if (!req.query.noCache) {
    const cached = detailCache.get(owner, repo, number);
    if (cached) return res.json(cached);
  }

  try {
    const detail = await github.fetchPRDetail(req.token, owner, repo, number);
    // Don't cache partial-failure detail (unresolved threads fetch failed) —
    // otherwise the user sees the error banner for up to pollInterval seconds
    // even after GitHub recovers.
    if (!detail.unresolvedThreadsError) {
      detailCache.set(owner, repo, number, detail);
    }
    res.json(detail);
  } catch (err) {
    console.error('PR detail failed:', err.message);
    sendError(res, err.status || 500, ERROR_CODES.INTERNAL_ERROR, err.message);
  }
});

router.post('/api/prs/refresh', async (req, res) => {
  const me = await resolveMe(req.token, req.query.assignee);

  cache.clear();
  detailCache.clear();
  await fetchAllPRs(req.token);
  res.json(await buildResponse(cache.get() || [], me));
});

export default router;
