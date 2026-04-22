import { Router } from 'express';
import * as store from '../store.js';
import * as cache from '../cache.js';
import * as detailCache from '../detailCache.js';
import * as github from '../github.js';
import { ERROR_CODES, mapGithubError, sendError } from '../httpError.js';
import { tokenHash } from '../tokenHash.js';

const router = Router();

// hash(token) -> { login, expiresAt } (10 min TTL, 200 entry cap).
// resolveMe is called on every /api/prs poll; caching avoids 1 GitHub /user call per minute per user.
// Tokens are hashed (not stored verbatim) so a heap dump never exposes credentials.
const ME_TTL_MS = 10 * 60 * 1000;
const ME_CACHE_MAX = 200;
const meCache = new Map();

// Coalesce concurrent fetchAllPRs calls so that a thundering herd of cache-miss
// requests results in only one GraphQL fan-out.
// NOTE: This dashboard is designed for single-tenant local use (one GitHub
// identity per backend process). The inflight Promise and the global cache
// are deliberately not partitioned by token — that would be a no-op here and
// just add complexity. If multi-tenant deployment is ever attempted, both
// must be partitioned (e.g. keyed by sha256(token)) and the architecture
// reviewed end-to-end.
let inflightFetchAll = null;

export async function fetchAllPRs(token, me = null, { force = false } = {}) {
  // `force` is used by /api/prs/refresh: if a poll-triggered fetch is already
  // inflight when refresh fires, awaiting that stale Promise would silently
  // defeat the user's "give me the latest right now" intent. Cancel the
  // coalesce in that case so refresh actually re-runs.
  if (inflightFetchAll && !force) return inflightFetchAll;
  if (force) inflightFetchAll = null;
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

    const previous = cache.peek() || [];
    const previousByRepo = new Map(previous.map((r) => [r.repo, r]));

    let results;
    if (me) {
      // Server-side filter via GitHub's GraphQL search. Reduces fan-out from
      // N repos -> ~ceil(N/5)*2 search queries, AND makes GitHub do the
      // assignee/reviewer matching instead of fetching everything and
      // throwing most of it away.
      console.log(
        `Fetch (search): involves/review-requested for ${me} across ${activeRepos.length} repo(s)`,
      );
      try {
        results = await github.searchOpenPRsForMe(
          token,
          activeRepos.map((r) => r.id),
          me,
        );
      } catch (err) {
        // Search itself failed wholesale — fall back to per-repo so the user
        // gets at least partial data. Log distinctly so this is debuggable.
        console.warn(`Search failed (${err.message}), falling back to per-repo fetch`);
        results = await fetchPerRepo(token, activeRepos, previousByRepo);
      }
    } else {
      console.log(
        `Fetch: per-repo for ${activeRepos.length}/${allRepos.length} repo(s) (others paused)`,
      );
      results = await fetchPerRepo(token, activeRepos, previousByRepo);
    }

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

// Per-repo fetch path used when no `me` is set or as fallback when the
// server-side search query fails. previousByRepo lets us carry the last
// successful PR list forward when one repo's refetch errors out (e.g.
// WinTicket/app's recurring GitHub 502).
async function fetchPerRepo(token, activeRepos, previousByRepo) {
  return Promise.all(
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
        const prev = previousByRepo.get(repo.id);
        return {
          repo: repo.id,
          prs: prev?.prs || [],
          error: { message: err.message, status: err.status || null },
        };
      }
    }),
  );
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
  const key = tokenHash(token);
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
    const paused = !!w.paused;
    return {
      repo: w.id,
      paused,
      // Paused repos must surface zero PRs even if the cache still holds a
      // pre-pause snapshot. Otherwise a freshly-paused repo flickers back its
      // last-known PRs for one polling cycle until cache.upsertRepo runs.
      prs: paused ? [] : cached ? cached.prs : [],
      error: paused ? null : cached ? cached.error : null,
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

  await fetchAllPRs(req.token, me);
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
    // Log the full GitHub error for ops, but return a generic body to the
    // client so internal paths / GraphQL diagnostics don't leak via /api/.
    console.error(`Single repo fetch failed for ${repoId}:`, err.message);
    const mapped = mapGithubError(err);
    if (mapped) return sendError(res, mapped.status, mapped.code, mapped.message);
    sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, 'Failed to fetch repository');
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
    // Don't cache partial-failure detail (any sub-fetch failed) — otherwise
    // the user sees the error banner for up to pollInterval seconds even
    // after GitHub recovers. New error fields go in this list.
    if (!detail.unresolvedThreadsError && !detail.failedChecksError) {
      detailCache.set(owner, repo, number, detail);
    }
    res.json(detail);
  } catch (err) {
    console.error('PR detail failed:', err.message);
    const mapped = mapGithubError(err);
    if (mapped) return sendError(res, mapped.status, mapped.code, mapped.message);
    sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, 'Failed to fetch PR detail');
  }
});

router.post('/api/prs/refresh', async (req, res) => {
  const me = await resolveMe(req.token, req.query.assignee);

  cache.clear();
  detailCache.clear();
  await fetchAllPRs(req.token, me, { force: true });
  res.json(await buildResponse(cache.get() || [], me));
});

export default router;
