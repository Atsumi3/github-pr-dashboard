import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOpenPRs, searchOpenPRsForMe } from './github.js';

const reviewTime = '2026-11-20T10:00:00Z';

function review(id, { submittedAt = reviewTime, state = 'COMMENTED', author = null } = {}) {
  return {
    id,
    submittedAt,
    state,
    author,
    url: `https://github.com/example/project/pull/7#pullrequestreview-${id}`,
  };
}

function prNode() {
  return {
    number: 7,
    title: 'Review events',
    url: 'https://github.com/example/project/pull/7',
    isDraft: false,
    state: 'OPEN',
    author: { login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
    headRefName: 'feature/reviews',
    baseRefName: 'main',
    assignees: { nodes: [] },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    reviews: {
      nodes: [
        review('bot-review', {
          author: {
            login: 'dependabot[bot]',
            avatarUrl: 'https://avatars.githubusercontent.com/u/2',
          },
        }),
        review('deleted-author'),
        review('pending-review', { submittedAt: null, state: 'PENDING' }),
        review('pending-with-time', { state: 'PENDING' }),
        review('null-submission', { submittedAt: null }),
      ],
    },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: { nodes: [] },
    createdAt: reviewTime,
    updatedAt: reviewTime,
  };
}

function withGraphQLResponse(t, makeData) {
  const originalFetch = globalThis.fetch;
  const queries = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    queries.push(body.query);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: makeData(body.query) }),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return queries;
}

function assertReviewEvents(pr) {
  assert.deepEqual(
    pr.reviewEvents.map(({ id, state, author }) => ({ id, state, author })),
    [
      {
        id: 'bot-review',
        state: 'COMMENTED',
        author: {
          login: 'dependabot[bot]',
          avatarUrl: 'https://avatars.githubusercontent.com/u/2',
        },
      },
      { id: 'deleted-author', state: 'COMMENTED', author: null },
    ],
  );
  assert.equal(pr.reviewEvents[0].submittedAt, reviewTime);
  assert.match(pr.reviewEvents[0].url, /#pullrequestreview-bot-review$/);
}

test('per-repository query maps submitted review events including bots and deleted authors', async (t) => {
  const queries = withGraphQLResponse(t, () => ({
    repository: { pullRequests: { nodes: [prNode()] } },
  }));

  const [pr] = await fetchOpenPRs('test-token', 'example/project');

  assertReviewEvents(pr);
  assert.match(
    queries[0],
    /reviews\(last: 50, states: \[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED\]\)/,
  );
  assert.match(queries[0], /id\s+submittedAt\s+state/);
});

test('cross-repository search query maps the same submitted review event shape', async (t) => {
  const queries = withGraphQLResponse(t, () => ({
    search: {
      nodes: [
        {
          ...prNode(),
          repository: { nameWithOwner: 'example/project' },
        },
      ],
    },
  }));

  const repos = await searchOpenPRsForMe('test-token', ['example/project'], 'octocat');
  const [pr] = repos[0].prs;

  assertReviewEvents(pr);
  assert.equal(repos[0].repo, 'example/project');
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(
      query,
      /reviews\(last: 50, states: \[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED\]\)/,
    );
  }
});

test('cross-repository search groups results case-insensitively and preserves watched casing', async (t) => {
  let graphQLRepo;
  const queries = withGraphQLResponse(t, () => ({
    search: {
      nodes: [
        {
          ...prNode(),
          repository: { nameWithOwner: graphQLRepo },
        },
      ],
    },
  }));

  for (const [watchedRepo, returnedRepo] of [
    ['Fixture-Org/Sample-Repo', 'fixture-org/sample-repo'],
    ['fixture-org/sample-repo', 'Fixture-Org/Sample-Repo'],
  ]) {
    graphQLRepo = returnedRepo;
    const [result] = await searchOpenPRsForMe('test-token', [watchedRepo], 'octocat');

    assert.equal(result.repo, watchedRepo);
    assert.equal(result.prs.length, 1);
    assertReviewEvents(result.prs[0]);
  }
  assert.equal(queries.length, 4);
});

test('cross-repository search returns each case-equivalent watched spelling', async (t) => {
  const queries = withGraphQLResponse(t, () => ({
    search: {
      nodes: [
        {
          ...prNode(),
          repository: { nameWithOwner: 'fixture-org/sample-repo' },
        },
      ],
    },
  }));

  const watched = ['Fixture-Org/Sample-Repo', 'fixture-org/sample-repo'];
  const results = await searchOpenPRsForMe('test-token', watched, 'octocat');

  assert.deepEqual(
    results.map(({ repo, prs, error }) => ({ repo, prCount: prs.length, error })),
    watched.map((repo) => ({ repo, prCount: 1, error: null })),
  );
  for (const { prs } of results) assertReviewEvents(prs[0]);
  assert.equal(queries.length, 2);
});

test('empty review connections normalize to an empty event list', async (t) => {
  const node = prNode();
  node.reviews = { nodes: [] };
  withGraphQLResponse(t, () => ({ repository: { pullRequests: { nodes: [node] } } }));

  const [pr] = await fetchOpenPRs('test-token', 'example/project');

  assert.deepEqual(pr.reviewEvents, []);
});
