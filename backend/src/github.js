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
const OPEN_PRS_QUERY = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
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
          assignees(first: 5) {
            nodes { login avatarUrl }
          }
          reviewRequests(first: 5) {
            nodes {
              requestedReviewer {
                __typename
                ... on User { login avatarUrl }
              }
            }
          }
          latestOpinionatedReviews(first: 20, writersOnly: false) {
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
          labels(first: 10) {
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
        signal: AbortSignal.timeout(30000),
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

export async function fetchOpenPRs(token, repoFullName) {
  const [owner, name] = repoFullName.split('/');
  if (!owner || !name) {
    throw Object.assign(new Error('Invalid repoFullName'), { status: 400, repoFullName });
  }

  const json = await gqlWithRetry(token, OPEN_PRS_QUERY, { owner, name }, repoFullName);
  const nodes = json.data?.repository?.pullRequests?.nodes || [];

  // Map GraphQL PR nodes to the legacy REST-shaped response the frontend expects.
  // For behind/ahead we need an integer count which GraphQL does not expose; we fall
  // back to the REST /compare endpoint only for PRs that are likely behind, i.e.
  // mergeStateStatus === 'BEHIND' or 'DIRTY'/'BLOCKED' where staleness is plausible.
  // PRs that are CLEAN/UNSTABLE/HAS_HOOKS/UNKNOWN with mergeable === MERGEABLE are
  // treated as behindBy: 0 to avoid making 100 REST calls and defeating the purpose.
  const NEEDS_COMPARE = new Set(['BEHIND', 'DIRTY', 'BLOCKED']);

  const mapped = nodes.map((pr) => {
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
      // deriveReviewStatus expects REST-style review objects: { user: { login }, state }
      reviews.map((r) => ({ user: { login: r.login }, state: r.state })),
      requestedReviewers,
    );

    const rollupState = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null;
    const ciStatus = rollupState ? { state: mapRollupState(rollupState), total: null } : null;

    // Translate GraphQL enums into the lower-cased values the REST API returned.
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
      assignees: (pr.assignees?.nodes || []).map((a) => ({
        login: a.login,
        avatarUrl: a.avatarUrl,
      })),
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
  });

  // Selective REST fallback: only the PRs that GraphQL flagged as potentially behind
  // need an exact behind/ahead count. This keeps total requests at 1 (GraphQL) + N
  // (only the BEHIND/DIRTY/BLOCKED subset) instead of 1 + 4 * total.
  const needCompare = mapped.filter((p) => p._needsCompare);
  await Promise.all(
    needCompare.map(async (p) => {
      const cmp = await fetchCompare(token, repoFullName, p._baseRef, p._headRef);
      p.behindBy = cmp?.behindBy ?? null;
      p.aheadBy = cmp?.aheadBy ?? null;
    }),
  );

  // Strip internal helper fields before returning.
  return mapped.map(({ _needsCompare, _baseRef, _headRef, ...rest }) => rest);
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

export async function fetchPRDetail(token, owner, repo, number) {
  const repoFullName = `${owner}/${repo}`;

  const [prRes, filesRes, threadsResult] = await Promise.all([
    fetch(`${API_BASE}/repos/${repoFullName}/pulls/${number}`, { headers: headers(token) }),
    fetch(`${API_BASE}/repos/${repoFullName}/pulls/${number}/files?per_page=100`, {
      headers: headers(token),
    }),
    fetchUnresolvedThreads(token, owner, repo, number),
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
    })),
    unresolvedThreads: threadsResult.items,
    unresolvedThreadsError: threadsResult.error,
  };
}
