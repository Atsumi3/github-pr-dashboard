const API_BASE = 'https://api.github.com';
const HEADERS_BASE = {
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'pr-dashboard',
};

function headers(token) {
  return { ...HEADERS_BASE, Authorization: `token ${token}` };
}

export async function getUser(token) {
  const res = await fetch(`${API_BASE}/user`, { headers: headers(token) });
  if (!res.ok) throw Object.assign(new Error('GitHub API error'), { status: res.status });
  const data = await res.json();
  return { login: data.login, avatarUrl: data.avatar_url };
}

export async function verifyRepo(token, owner, repo) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}`, { headers: headers(token) });
  return res.ok;
}

export async function searchRepos(token, query) {
  const res = await fetch(
    `${API_BASE}/search/repositories?q=${encodeURIComponent(query)}&per_page=20`,
    {
      headers: headers(token),
    },
  );
  if (!res.ok) throw Object.assign(new Error('GitHub API error'), { status: res.status });
  const data = await res.json();
  return data.items.map((item) => ({
    fullName: item.full_name,
    description: item.description || '',
    private: item.private,
  }));
}

export async function listUserRepos(token, query) {
  // List repos the authenticated user has access to, filtered by name
  const res = await fetch(
    `${API_BASE}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`,
    {
      headers: headers(token),
    },
  );
  if (!res.ok) return [];
  const data = await res.json();
  const q = query.toLowerCase();
  return data
    .filter(
      (item) =>
        item.full_name.toLowerCase().includes(q) ||
        (item.description || '').toLowerCase().includes(q),
    )
    .map((item) => ({
      fullName: item.full_name,
      description: item.description || '',
      private: item.private,
    }));
}

// GraphQL query for fetching open PRs in a single round-trip.
// Replaces the previous REST-based N+1 (1 list call + 4 calls per PR) with one GraphQL call.
// Per-PR data fetched here:
//   - basic PR fields (number/title/url/draft/state/branch/etc.)
//   - author / assignees / requested reviewers (for header chips)
//   - latestOpinionatedReviews: per-user latest APPROVED / CHANGES_REQUESTED / DISMISSED state
//   - commits.last(1).statusCheckRollup: combined CI rollup state for the head commit
//   - mergeable / mergeStateStatus: used to decide if behind/ahead REST fallback is needed
// We deliberately keep the per-PR sub-collections small. GitHub's GraphQL
// node-cost is roughly outer × Σ(inner first:N), so trimming each connection
// has multiplicative payoff (~1/3 of the previous request size for a typical
// repo). 10 PRs is enough for the dashboard's per-repo display since we only
// surface the most recently-updated work; users who want more can open the
// repo on github.com directly.
//
// NOTE: This GraphQL endpoint cannot filter by assignee/reviewer — the
// `assignee=me` query parameter the frontend sends only controls a backend
// post-fetch filter (isRelatedToMe). True server-side filtering would need
// the GitHub search API (`is:pr is:open assignee:me`), which is a different
// architecture (single search across all watched repos rather than per-repo
// fetch-then-filter).
const OPEN_PRS_QUERY = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes {
          number
          title
          url
          isDraft
          state
          headRefName
          baseRefName
          additions
          deletions
          mergeable
          mergeStateStatus
          createdAt
          updatedAt
          author {
            login
            avatarUrl
          }
          assignees(first: 3) {
            nodes { login avatarUrl }
          }
          reviewRequests(first: 3) {
            nodes {
              requestedReviewer {
                __typename
                ... on User { login avatarUrl }
              }
            }
          }
          latestOpinionatedReviews(first: 10, writersOnly: false) {
            nodes {
              state
              author { login avatarUrl }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state }
              }
            }
          }
          labels(first: 6) {
            nodes { name color }
          }
        }
      }
    }
  }
`;

// GraphQL search variant — reuses the same PR field set as OPEN_PRS_QUERY,
// but selects PullRequest nodes that match a server-side search query
// (`is:pr is:open involves:USER repo:... repo:...`). This is the only way
// to get true server-side "my PRs" filtering; the pullRequests connection
// doesn't accept assignee/reviewer filters.
const SEARCH_PRS_QUERY = `
  query($q: String!) {
    search(query: $q, type: ISSUE, first: 50) {
      nodes {
        ... on PullRequest {
          number
          title
          url
          isDraft
          state
          headRefName
          baseRefName
          additions
          deletions
          mergeable
          mergeStateStatus
          createdAt
          updatedAt
          repository { nameWithOwner }
          author { login avatarUrl }
          assignees(first: 3) {
            nodes { login avatarUrl }
          }
          reviewRequests(first: 3) {
            nodes {
              requestedReviewer {
                __typename
                ... on User { login avatarUrl }
              }
            }
          }
          latestOpinionatedReviews(first: 10, writersOnly: false) {
            nodes {
              state
              author { login avatarUrl }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state }
              }
            }
          }
          labels(first: 6) {
            nodes { name color }
          }
        }
      }
    }
  }
`;

async function gqlWithRetry(token, query, variables, repoFullName, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${API_BASE}/graphql`, {
        method: 'POST',
        headers: { ...headers(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        // 15s per-attempt cap. With attempts=3 + 1s/2s backoff this puts the
        // worst-case at ~48s, leaving headroom under nginx's 60s
        // proxy_read_timeout (frontend/nginx.conf).
        signal: AbortSignal.timeout(15000),
      });
      if (res.status >= 500 && i < attempts - 1) {
        lastErr = Object.assign(new Error('GitHub API error'), {
          status: res.status,
          repoFullName,
        });
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      if (!res.ok) {
        throw Object.assign(new Error('GitHub API error'), { status: res.status, repoFullName });
      }
      const json = await res.json();
      if (json.errors && (!json.data || !json.data.repository)) {
        throw Object.assign(new Error('GitHub GraphQL error'), {
          status: 502,
          repoFullName,
          errors: json.errors,
        });
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// PRs flagged BEHIND / DIRTY / BLOCKED by mergeStateStatus need an exact
// integer behind/ahead count. Everything else is treated as 0 so we don't
// hammer REST /compare unnecessarily.
const NEEDS_COMPARE = new Set(['BEHIND', 'DIRTY', 'BLOCKED']);

// Map one GraphQL PullRequest node to the shape the frontend expects.
// Kept separate so both per-repo (OPEN_PRS_QUERY) and cross-repo search paths
// produce identical PR objects.
function mapPrNode(pr) {
  const reviews = (pr.latestOpinionatedReviews?.nodes || [])
    .filter((r) => r.author && r.state)
    .map((r) => ({
      login: r.author.login,
      state: r.state,
      avatarUrl: r.author.avatarUrl,
    }));

  const requestedReviewers = (pr.reviewRequests?.nodes || [])
    .map((rr) => rr.requestedReviewer)
    .filter((u) => u && u.__typename === 'User')
    .map((u) => ({ login: u.login, avatarUrl: u.avatarUrl }));

  const reviewStatus = deriveReviewStatus(
    reviews.map((r) => ({ user: { login: r.login }, state: r.state })),
    requestedReviewers,
  );

  const rollupState = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null;
  const ciStatus = rollupState ? { state: mapRollupState(rollupState), total: null } : null;

  const mergeable = mapMergeable(pr.mergeable);
  const mergeableState = pr.mergeStateStatus ? pr.mergeStateStatus.toLowerCase() : null;

  const labels = (pr.labels?.nodes || [])
    .filter((l) => l && l.name)
    .map((l) => ({ name: l.name, color: normalizeLabelColor(l.color) }));

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    draft: pr.isDraft || false,
    labels,
    state: pr.state ? pr.state.toLowerCase() : 'open',
    author: pr.author
      ? { login: pr.author.login, avatarUrl: pr.author.avatarUrl }
      : { login: 'ghost', avatarUrl: '' },
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    assignees: (pr.assignees?.nodes || []).map((a) => ({ login: a.login, avatarUrl: a.avatarUrl })),
    requestedReviewers,
    reviewStatus,
    reviews,
    ciStatus,
    mergeable,
    mergeableState,
    behindBy: NEEDS_COMPARE.has(pr.mergeStateStatus) ? null : 0,
    aheadBy: null,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    _needsCompare: NEEDS_COMPARE.has(pr.mergeStateStatus),
    _baseRef: pr.baseRefName,
    _headRef: pr.headRefName,
  };
}

async function resolveCompares(token, prs, repoFullNameResolver) {
  const need = prs.filter((p) => p._needsCompare);
  await Promise.all(
    need.map(async (p) => {
      const repoFullName = repoFullNameResolver(p);
      const cmp = await fetchCompare(token, repoFullName, p._baseRef, p._headRef);
      p.behindBy = cmp?.behindBy ?? null;
      p.aheadBy = cmp?.aheadBy ?? null;
    }),
  );
  return prs.map(({ _needsCompare, _baseRef, _headRef, ...rest }) => rest);
}

export async function fetchOpenPRs(token, repoFullName) {
  const [owner, name] = repoFullName.split('/');
  if (!owner || !name) {
    throw Object.assign(new Error('Invalid repoFullName'), { status: 400, repoFullName });
  }

  const json = await gqlWithRetry(token, OPEN_PRS_QUERY, { owner, name }, repoFullName);
  const nodes = json.data?.repository?.pullRequests?.nodes || [];
  const mapped = nodes.map(mapPrNode);
  return resolveCompares(token, mapped, () => repoFullName);
}

// GitHub search queries are roughly 256 chars effectively; 5 repos per chunk
// × ~30 chars each ≈ 150 chars, safe with room for qualifiers.
const SEARCH_CHUNK_SIZE = 5;

// Cross-repo, server-side-filtered fetch of PRs "relevant to me".
// Two queries per chunk (GitHub search AND-joins qualifiers; there's no OR
// syntax for separate user qualifiers), deduped and grouped by repository.
//
// Returns [{ repo, prs, error }] for every watched repo, with empty `prs`
// for repos where the user has no involvement. That shape matches what
// fetchAllPRs previously produced per-repo so the downstream cache/
// buildResponse don't need to know which path ran.
export async function searchOpenPRsForMe(token, repoFullNames, me) {
  if (!me || !Array.isArray(repoFullNames) || repoFullNames.length === 0) {
    return repoFullNames.map((id) => ({ repo: id, prs: [], error: null }));
  }

  const chunks = [];
  for (let i = 0; i < repoFullNames.length; i += SEARCH_CHUNK_SIZE) {
    chunks.push(repoFullNames.slice(i, i + SEARCH_CHUNK_SIZE));
  }

  // For each chunk, run both queries in parallel. `involves` covers
  // assignee/author/mentions/commenter; `review-requested` covers reviewers
  // who haven't interacted yet — combined this matches the old
  // isRelatedToMe positive cases (minus the broad "any REVIEW_REQUIRED PR"
  // catch-all, which the user explicitly wanted dropped).
  async function searchChunk(chunkRepos, qualifier) {
    const repoFilter = chunkRepos.map((id) => `repo:${id}`).join(' ');
    const q = `is:pr is:open ${qualifier}:${me} ${repoFilter}`;
    const json = await gqlWithRetry(token, SEARCH_PRS_QUERY, { q }, q);
    return (json.data?.search?.nodes || []).filter((n) => n && n.number);
  }

  const rawNodes = (
    await Promise.all(
      chunks.flatMap((chunk) => [
        searchChunk(chunk, 'involves'),
        searchChunk(chunk, 'review-requested'),
      ]),
    )
  ).flat();

  // Dedupe by url (same PR can appear in both queries) and group by repo.
  const byUrl = new Map();
  for (const node of rawNodes) byUrl.set(node.url, node);

  const mapped = Array.from(byUrl.values()).map((node) => {
    const pr = mapPrNode(node);
    pr._repoFullName = node.repository?.nameWithOwner || '';
    return pr;
  });

  const resolved = await resolveCompares(token, mapped, (p) => p._repoFullName);

  const byRepo = new Map();
  for (const id of repoFullNames) byRepo.set(id, []);
  for (const pr of resolved) {
    const repoId = pr._repoFullName;
    delete pr._repoFullName;
    if (byRepo.has(repoId)) byRepo.get(repoId).push(pr);
  }

  return Array.from(byRepo, ([repo, prs]) => ({ repo, prs, error: null }));
}

function mapRollupState(state) {
  // GraphQL StatusState enum -> REST combined-status string the frontend expects.
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return state ? state.toLowerCase() : null;
  }
}

function normalizeLabelColor(color) {
  if (typeof color !== 'string') return '#888888';
  const hex = color.replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '#888888';
  return `#${hex.toLowerCase()}`;
}

function mapMergeable(value) {
  // GraphQL MergeableState (MERGEABLE/CONFLICTING/UNKNOWN) -> REST boolean|null.
  if (value === 'MERGEABLE') return true;
  if (value === 'CONFLICTING') return false;
  return null;
}

async function fetchCompare(token, repoFullName, baseRef, headRef) {
  try {
    const res = await fetch(
      `${API_BASE}/repos/${repoFullName}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`,
      { headers: headers(token) },
    );
    if (!res.ok) return null;
    const cmp = await res.json();
    return { behindBy: cmp.behind_by, aheadBy: cmp.ahead_by };
  } catch {
    return null;
  }
}

export async function suggestRepos(token, username) {
  const queries = [
    `is:pr is:open assignee:${username}`,
    `is:pr is:open author:${username}`,
    `is:pr is:open review-requested:${username}`,
  ];

  const results = await Promise.all(
    queries.map(async (q) => {
      const res = await fetch(`${API_BASE}/search/issues?q=${encodeURIComponent(q)}&per_page=100`, {
        headers: headers(token),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.items || [];
    }),
  );

  const REASON_LABELS = ['assigned', 'author', 'review-requested'];
  const repoMap = new Map();
  // Each PR appears in multiple result buckets when the user matches more than
  // one role (e.g. assignee + reviewer). De-dupe per repo by issue id so prCount
  // reflects unique PRs, not query hits.
  const seenIdsByRepo = new Map();

  results.forEach((items, idx) => {
    const reason = REASON_LABELS[idx];
    for (const item of items) {
      const repoFullName = item.repository_url.replace('https://api.github.com/repos/', '');
      if (!repoMap.has(repoFullName)) {
        repoMap.set(repoFullName, { repo: repoFullName, prCount: 0, reasons: new Set() });
        seenIdsByRepo.set(repoFullName, new Set());
      }
      const entry = repoMap.get(repoFullName);
      const seen = seenIdsByRepo.get(repoFullName);
      if (!seen.has(item.id)) {
        seen.add(item.id);
        entry.prCount++;
      }
      entry.reasons.add(reason);
    }
  });

  return [...repoMap.values()]
    .map((r) => ({ ...r, reasons: [...r.reasons] }))
    .sort((a, b) => b.prCount - a.prCount);
}

function deriveReviewStatus(reviews, requestedReviewers) {
  if (reviews.length === 0 && requestedReviewers.length > 0) return 'REVIEW_REQUIRED';
  if (reviews.length === 0) return 'PENDING';

  const latestByUser = new Map();
  for (const review of reviews) {
    if (review.state === 'COMMENTED') continue;
    latestByUser.set(review.user.login, review.state);
  }

  const states = [...latestByUser.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (states.includes('APPROVED')) return 'APPROVED';
  return 'PENDING';
}

async function fetchUnresolvedThreads(token, owner, repo, number) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              isResolved
              isOutdated
              path
              line
              comments(first: 20) {
                nodes {
                  body
                  url
                  createdAt
                  author { login avatarUrl }
                }
              }
            }
          }
        }
      }
    }
  `;
  try {
    const json = await gqlWithRetry(
      token,
      query,
      { owner, repo, number },
      `${owner}/${repo}#${number}`,
    );
    const threads = json.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
    const items = threads
      .filter((t) => !t.isResolved && !t.isOutdated)
      .map((t) => ({
        path: t.path,
        line: t.line,
        comments: (t.comments.nodes || []).map((c) => ({
          body: c.body,
          url: c.url,
          createdAt: c.createdAt,
          author: c.author ? { login: c.author.login, avatarUrl: c.author.avatarUrl } : null,
        })),
      }));
    return { items, error: null };
  } catch (err) {
    console.warn(`fetchUnresolvedThreads failed for ${owner}/${repo}#${number}:`, err.message);
    return { items: [], error: err.message || 'fetch failed' };
  }
}

// GraphQL exposes the head commit's full check matrix in one round-trip,
// which is cheaper than the REST equivalent (`/commits/:sha/check-runs`
// plus `/commits/:sha/statuses`). We surface only failed/cancelled/timed-out
// entries to the UI so reviewers immediately see what's blocking merge.
const PR_CHECKS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                      startedAt
                      completedAt
                      title
                      summary
                      annotations(first: 20) {
                        nodes {
                          path
                          annotationLevel
                          title
                          message
                          location {
                            start { line }
                            end { line }
                          }
                        }
                      }
                      checkSuite {
                        workflowRun {
                          workflow { name }
                        }
                      }
                    }
                    ... on StatusContext {
                      context
                      description
                      state
                      targetUrl
                      createdAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Backend filters down to failures-only before sending so we don't ship a
// 100-context check matrix to the browser on every detail-pane open. The
// frontend's FAILED_CHECK_LABELS map is a label-only concern (for UI text)
// and intentionally does NOT re-filter — the contract is "what backend sends
// is what UI shows". If GitHub adds a new failing conclusion, update this
// Set; the UI will fall back to the raw conclusion string.
const FAILED_CHECK_RUN_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);
const FAILED_STATUS_STATES = new Set(['FAILURE', 'ERROR']);

async function fetchPRChecks(token, owner, repo, number) {
  try {
    const json = await gqlWithRetry(
      token,
      PR_CHECKS_QUERY,
      { owner, name: repo, number },
      `${owner}/${repo}#${number}`,
    );
    const commit = json.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit;
    const rollup = commit?.statusCheckRollup;
    if (!rollup) return { rollupState: null, failed: [], error: null };
    const contexts = rollup.contexts?.nodes || [];
    const failed = contexts
      .map((ctx) => {
        if (ctx.__typename === 'CheckRun') {
          if (!FAILED_CHECK_RUN_CONCLUSIONS.has(ctx.conclusion)) return null;
          // Annotations point to the actual failing line(s) and are the
          // primary "what went wrong" signal. summary/title fall back to the
          // human-written output when annotations weren't emitted.
          const annotations = (ctx.annotations?.nodes || [])
            .filter((a) => a)
            .map((a) => ({
              path: a.path || null,
              level: a.annotationLevel || null,
              title: a.title || null,
              message: a.message || null,
              startLine: a.location?.start?.line ?? null,
              endLine: a.location?.end?.line ?? null,
            }));
          return {
            kind: 'check',
            name: ctx.checkSuite?.workflowRun?.workflow?.name
              ? `${ctx.checkSuite.workflowRun.workflow.name} / ${ctx.name}`
              : ctx.name,
            conclusion: ctx.conclusion,
            url: ctx.detailsUrl || null,
            completedAt: ctx.completedAt || null,
            title: ctx.title || null,
            summary: ctx.summary || null,
            annotations,
          };
        }
        if (ctx.__typename === 'StatusContext') {
          if (!FAILED_STATUS_STATES.has(ctx.state)) return null;
          return {
            kind: 'status',
            name: ctx.context,
            conclusion: ctx.state,
            url: ctx.targetUrl || null,
            description: ctx.description || null,
            completedAt: ctx.createdAt || null,
          };
        }
        return null;
      })
      .filter(Boolean);
    return { rollupState: rollup.state || null, failed, error: null };
  } catch (err) {
    console.warn(`fetchPRChecks failed for ${owner}/${repo}#${number}:`, err.message);
    return { rollupState: null, failed: [], error: err.message || 'fetch failed' };
  }
}

export async function fetchPRDetail(token, owner, repo, number) {
  const repoFullName = `${owner}/${repo}`;

  const [prRes, filesRes, threadsResult, checksResult] = await Promise.all([
    fetch(`${API_BASE}/repos/${repoFullName}/pulls/${number}`, { headers: headers(token) }),
    fetch(`${API_BASE}/repos/${repoFullName}/pulls/${number}/files?per_page=100`, {
      headers: headers(token),
    }),
    fetchUnresolvedThreads(token, owner, repo, number),
    fetchPRChecks(token, owner, repo, number),
  ]);

  if (!prRes.ok) throw Object.assign(new Error('GitHub API error'), { status: prRes.status });

  const pr = await prRes.json();
  const files = filesRes.ok ? await filesRes.json() : [];

  // pr from /pulls/:n already has mergeable; compare for behind/ahead
  const compare = await fetch(
    `${API_BASE}/repos/${repoFullName}/compare/${encodeURIComponent(pr.base.ref)}...${encodeURIComponent(pr.head.ref)}`,
    { headers: headers(token) },
  )
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body || '',
    url: pr.html_url,
    draft: pr.draft || false,
    state: pr.merged_at ? 'merged' : pr.state,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    behindBy: compare?.behind_by ?? null,
    aheadBy: compare?.ahead_by ?? null,
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      // GitHub omits `patch` for binary files and for large/renamed entries.
      // Frontend renders the unified diff inline when present, falls back to
      // a "binary or oversized" notice otherwise.
      patch: f.patch ?? null,
    })),
    unresolvedThreads: threadsResult.items,
    unresolvedThreadsError: threadsResult.error,
    checksRollupState: checksResult.rollupState,
    failedChecks: checksResult.failed,
    failedChecksError: checksResult.error,
  };
}
