import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewTracker } from './review-tracker.js';

const t0 = '2026-11-20T10:00:00.000Z';
const t1 = '2026-11-20T10:01:00.000Z';
const t2 = '2026-11-20T10:02:00.000Z';

function event(id, submittedAt = t0, state = 'COMMENTED', author = { login: 'octocat' }) {
  return {
    id,
    submittedAt,
    state,
    author,
    url: `https://github.com/example/project/pull/7#pullrequestreview-${id}`,
  };
}

function pr(number, reviewEvents = []) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/project/pull/${number}`,
    reviewEvents,
  };
}

function repo(prs, options = {}) {
  return { repo: 'example/project', prs, ...options };
}

function createStoredTracker() {
  let stored = null;
  const tracker = createReviewTracker({
    load: () => stored,
    save: (value) => {
      stored = structuredClone(value);
    },
  });
  tracker.setUser('octocat');
  return { tracker, getStored: () => stored };
}

test('first observations seed each PR without history notifications', () => {
  const tracker = createReviewTracker();
  tracker.setUser('octocat');

  assert.deepEqual(tracker.observeRepo(repo([]), { sequence: 1 }), []);
  assert.deepEqual(tracker.observeRepo(repo([pr(7, [event('old')])]), { sequence: 2 }), []);
  assert.deepEqual(tracker.getUnread('example/project', 7), []);
});

test('new COMMENTED bot and deleted-author reviews are tracked independently', () => {
  const tracker = createReviewTracker();
  tracker.setUser('octocat');
  tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });

  const added = tracker.observeRepo(
    repo([
      pr(7, [
        event('baseline'),
        event('bot', t1, 'COMMENTED', { login: 'dependabot[bot]' }),
        event('deleted', t1, 'COMMENTED', null),
      ]),
    ]),
    { sequence: 2 },
  );

  assert.deepEqual(added.map((item) => item.id).sort(), ['bot', 'deleted']);
  assert.equal(added.find((item) => item.id === 'bot').authorLogin, 'dependabot[bot]');
  assert.equal(added.find((item) => item.id === 'deleted').authorLogin, 'Unknown reviewer');
});

test('different review IDs with identical timestamps remain distinct', () => {
  const tracker = createReviewTracker();
  tracker.setUser('octocat');
  tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });

  const added = tracker.observeRepo(
    repo([pr(7, [event('baseline'), event('same-time-a', t0), event('same-time-b', t0)])]),
    { sequence: 2 },
  );

  assert.deepEqual(added.map((item) => item.id).sort(), ['same-time-a', 'same-time-b']);
});

test('unread and seen IDs survive reload and repeated snapshots do not retrigger', () => {
  const { tracker, getStored } = createStoredTracker();
  tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });
  const snapshot = repo([pr(7, [event('baseline'), event('new', t1)])]);
  assert.equal(tracker.observeRepo(snapshot, { sequence: 2 }).length, 1);

  const reloaded = createReviewTracker({ load: getStored });
  reloaded.setUser('octocat');
  assert.deepEqual(reloaded.getUnreadIds('example/project', 7), ['new']);
  assert.deepEqual(reloaded.observeRepo(snapshot, { sequence: 1 }), []);
  assert.deepEqual(
    reloaded.observeRepo(repo([pr(7, [...snapshot.prs[0].reviewEvents].reverse())]), {
      sequence: 2,
    }),
    [],
  );
  assert.deepEqual(reloaded.getUnreadIds('example/project', 7), ['new']);
});

test('shared tabs merge read acknowledgements before unread events and preserve later arrivals', () => {
  let stored = null;
  let writes = 0;
  const createTracker = () => {
    const tracker = createReviewTracker({
      load: () => stored,
      save: (value) => {
        stored = structuredClone(value);
        writes += 1;
      },
    });
    tracker.setUser('octocat');
    return tracker;
  };
  const trackerA = createTracker();
  const trackerB = createTracker();
  const baseline = repo([pr(7, [event('baseline')])]);
  trackerA.observeRepo(baseline, { sequence: 1 });
  trackerB.observeRepo(baseline, { sequence: 1 });

  const firstReview = repo([pr(7, [event('baseline'), event('R1', t1)])]);
  trackerA.observeRepo(firstReview, { sequence: 2 });
  trackerB.observeRepo(firstReview, { sequence: 2 });
  trackerA.markRead('example/project', 7, ['R1']);
  const staleReadEvent = structuredClone(stored);

  const laterReview = repo([pr(7, [event('baseline'), event('R1', t1), event('R2', t1)])]);
  assert.deepEqual(
    trackerB.observeRepo(laterReview, { sequence: 3 }).map((item) => item.id),
    ['R2'],
  );
  assert.deepEqual(trackerB.getUnreadIds('example/project', 7), ['R2']);

  const beforeStaleEvent = writes;
  trackerB.syncFromStorage(staleReadEvent);
  assert.deepEqual(trackerB.getUnreadIds('example/project', 7), ['R2']);
  assert.equal(writes, beforeStaleEvent);
  trackerB.syncFromStorage(staleReadEvent);
  assert.equal(writes, beforeStaleEvent);

  const reloaded = createTracker();
  assert.deepEqual(reloaded.getUnreadIds('example/project', 7), ['R2']);
});

test('storage sync repairs a stale write without echoing unchanged state', () => {
  let stored = null;
  let writes = 0;
  const createTracker = () => {
    const tracker = createReviewTracker({
      load: () => stored,
      save: (value) => {
        stored = structuredClone(value);
        writes += 1;
      },
    });
    tracker.setUser('octocat');
    return tracker;
  };
  const trackerA = createTracker();
  const trackerB = createTracker();
  const snapshot = repo([pr(7, [event('baseline'), event('R', t1)])]);
  trackerA.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });
  trackerB.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });
  trackerA.observeRepo(snapshot, { sequence: 2 });
  trackerB.observeRepo(snapshot, { sequence: 2 });
  const staleWrite = structuredClone(stored);
  trackerA.markRead('example/project', 7, ['R']);
  const readEvent = structuredClone(stored);
  stored = staleWrite;

  const beforeRepair = writes;
  trackerA.syncFromStorage(readEvent);
  assert.equal(writes, beforeRepair + 1);
  assert.deepEqual(trackerA.getUnreadIds('example/project', 7), []);

  const repaired = structuredClone(stored);
  const beforeNoopSync = writes;
  trackerB.syncFromStorage(repaired);
  trackerA.syncFromStorage(repaired);
  assert.deepEqual(trackerB.getUnreadIds('example/project', 7), []);
  assert.equal(writes, beforeNoopSync);
  const reloaded = createTracker();
  assert.deepEqual(reloaded.getUnreadIds('example/project', 7), []);
});

test('latest stored baseline state wins over stale tab and storage-event flags', () => {
  let stored = null;
  let writes = 0;
  const createTracker = () => {
    const tracker = createReviewTracker({
      load: () => stored,
      save: (value) => {
        stored = structuredClone(value);
        writes += 1;
      },
    });
    tracker.setUser('octocat');
    return tracker;
  };
  const trackerA = createTracker();
  const trackerB = createTracker();
  const paused = repo([], { paused: true });
  trackerA.observeRepo(paused, { sequence: 1 });
  trackerB.observeRepo(paused, { sequence: 1 });
  const stalePausedEvent = structuredClone(stored);

  trackerA.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 2 });
  const resumedState = structuredClone(stored);
  assert.equal(Object.hasOwn(resumedState.repoNeedsBaseline, 'example/project'), false);
  trackerB.syncFromStorage(resumedState);

  const beforeStaleEvent = writes;
  trackerB.syncFromStorage(stalePausedEvent);
  trackerA.syncFromStorage(stalePausedEvent);
  assert.equal(writes, beforeStaleEvent);

  const newlySubmitted = repo([pr(7, [event('baseline'), event('after-resume', t1)])]);
  assert.deepEqual(
    trackerB.observeRepo(newlySubmitted, { sequence: 2 }).map((item) => item.id),
    ['after-resume'],
  );
  assert.deepEqual(trackerB.getUnreadIds('example/project', 7), ['after-resume']);
  assert.equal(Object.hasOwn(stored.repoNeedsBaseline, 'example/project'), false);
});

test('storage sync ignores snapshots for another user without changing or writing state', () => {
  let stored = null;
  let writes = 0;
  const tracker = createReviewTracker({
    load: () => stored,
    save: (value) => {
      stored = structuredClone(value);
      writes += 1;
    },
  });
  tracker.setUser('octocat');
  tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });
  tracker.observeRepo(repo([pr(7, [event('baseline'), event('unread', t1)])]), { sequence: 2 });
  const beforeState = structuredClone(stored);
  const beforeWrites = writes;

  assert.equal(
    tracker.syncFromStorage({
      ...beforeState,
      userLogin: 'another-user',
      prs: {},
      repoNeedsBaseline: { 'other/repo': true },
    }),
    false,
  );
  assert.equal(writes, beforeWrites);
  assert.deepEqual(stored, beforeState);
  assert.deepEqual(tracker.getUnreadIds('example/project', 7), ['unread']);
});

test('unread events survive transient disappearance and older unseen events do not notify', () => {
  const tracker = createReviewTracker();
  tracker.setUser('octocat');
  tracker.observeRepo(repo([pr(7, [event('baseline', t1)])]), { sequence: 1 });
  tracker.observeRepo(repo([pr(7, [event('baseline', t1), event('unread', t2)])]), { sequence: 2 });

  assert.deepEqual(tracker.observeRepo(repo([]), { sequence: 3 }), []);
  assert.deepEqual(tracker.getUnreadIds('example/project', 7), ['unread']);
  assert.deepEqual(
    tracker.observeRepo(
      repo([pr(7, [event('baseline', t1), event('unread', t2), event('older', t0)])]),
      { sequence: 4 },
    ),
    [],
  );
  assert.deepEqual(tracker.getUnreadIds('example/project', 7), ['unread']);
});

test('mark-read clears captured IDs but a later same-timestamp review stays unread', () => {
  const tracker = createReviewTracker();
  tracker.setUser('octocat');
  tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });
  tracker.observeRepo(repo([pr(7, [event('baseline'), event('first', t1)])]), { sequence: 2 });

  assert.equal(tracker.markRead('example/project', 7, ['first']), 1);
  assert.deepEqual(tracker.getUnreadIds('example/project', 7), []);
  assert.deepEqual(
    tracker
      .observeRepo(repo([pr(7, [event('baseline'), event('first', t1), event('later', t1)])]), {
        sequence: 3,
      })
      .map((item) => item.id),
    ['later'],
  );
  assert.deepEqual(tracker.getUnreadIds('example/project', 7), ['later']);
});

test('pause baselines accumulated reviews on resume without clearing existing unread state', () => {
  const tracker = createReviewTracker();
  tracker.setUser('octocat');
  tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });
  tracker.observeRepo(repo([pr(7, [event('baseline'), event('unread', t1)])]), { sequence: 2 });
  tracker.observeRepo(repo([], { paused: true }), { sequence: 3 });

  assert.deepEqual(
    tracker.observeRepo(
      repo([pr(7, [event('baseline'), event('unread', t1), event('while-paused', t2)])]),
      {
        sequence: 4,
      },
    ),
    [],
  );
  assert.deepEqual(tracker.getUnreadIds('example/project', 7), ['unread']);
  assert.deepEqual(
    tracker
      .observeRepo(
        repo([
          pr(7, [
            event('baseline'),
            event('unread', t1),
            event('while-paused', t2),
            event('after', t2),
          ]),
        ]),
        { sequence: 5 },
      )
      .map((item) => item.id),
    ['after'],
  );
});

test('errored snapshots are skipped and a later successful snapshot can detect new reviews', () => {
  const tracker = createReviewTracker();
  tracker.setUser('octocat');
  tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });
  const newer = repo([pr(7, [event('baseline'), event('after-error', t1)])], {
    error: { message: 'temporary failure' },
  });

  assert.deepEqual(tracker.observeRepo(newer, { sequence: 2 }), []);
  assert.deepEqual(
    tracker.observeRepo(repo(newer.prs), { sequence: 3 }).map((item) => item.id),
    ['after-error'],
  );
});

test('stale responses cannot advance a repo beyond a newer observation', () => {
  const tracker = createReviewTracker();
  tracker.setUser('octocat');
  tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });
  assert.deepEqual(
    tracker
      .observeRepo(repo([pr(7, [event('baseline'), event('newer', t1)])]), { sequence: 3 })
      .map((item) => item.id),
    ['newer'],
  );
  assert.deepEqual(
    tracker.observeRepo(repo([pr(7, [event('baseline'), event('stale', t2)])]), { sequence: 2 }),
    [],
  );
  assert.deepEqual(tracker.getUnreadIds('example/project', 7), ['newer']);
});

test('full-list and per-repository snapshots deduplicate the same review event', () => {
  const tracker = createReviewTracker();
  tracker.setUser('octocat');
  tracker.observeSnapshot({ repos: [repo([pr(7, [event('baseline')])])] }, { sequence: 1 });

  const snapshot = repo([pr(7, [event('baseline'), event('shared', t1)])]);
  assert.deepEqual(
    tracker.observeSnapshot({ repos: [snapshot] }, { sequence: 2 }).map((item) => item.id),
    ['shared'],
  );
  assert.deepEqual(tracker.observeRepo(snapshot, { sequence: 3 }), []);
  assert.deepEqual(tracker.observeSnapshot({ repos: [snapshot] }, { sequence: 2 }), []);
});

test('malformed persisted state is ignored and storage write errors fall back to memory', () => {
  const tracker = createReviewTracker({
    load: () => ({ version: 999, userLogin: 'octocat', prs: { invalid: 'state' } }),
    save: () => {
      throw new Error('storage disabled');
    },
  });
  tracker.setUser('octocat');
  assert.deepEqual(tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 }), []);
  assert.deepEqual(
    tracker
      .observeRepo(repo([pr(7, [event('baseline'), event('memory-only', t1)])]), { sequence: 2 })
      .map((item) => item.id),
    ['memory-only'],
  );
});

test('storage read failures still allow in-memory tracking', () => {
  const tracker = createReviewTracker({
    load: () => {
      throw new Error('storage unavailable');
    },
    save: () => {
      throw new Error('storage unavailable');
    },
  });
  tracker.setUser('octocat');
  tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 1 });

  assert.deepEqual(
    tracker
      .observeRepo(repo([pr(7, [event('baseline'), event('memory-only', t1)])]), { sequence: 2 })
      .map((item) => item.id),
    ['memory-only'],
  );
});

test('restored tracker state is bounded before it is persisted again', () => {
  const unread = Array.from({ length: 300 }, (_, index) => ({
    id: `stored-${index}`,
    submittedAt: new Date(Date.parse(t0) + index * 1000).toISOString(),
    state: 'COMMENTED',
    authorLogin: 'octocat',
    authorAvatarUrl: '',
    url: 'https://github.com/example/project/pull/1',
    prTitle: 'PR 1',
    prUrl: 'https://github.com/example/project/pull/1',
  }));
  const prs = Object.fromEntries(
    Array.from({ length: 501 }, (_, index) => [
      `owner${index}/repo#${index + 1}`,
      {
        initialized: true,
        seenIds: Array.from({ length: 1000 }, (_unused, id) => `seen-${id}`),
        unread: index === 0 ? unread : [],
      },
    ]),
  );
  const repoNeedsBaseline = Object.fromEntries(
    Array.from({ length: 501 }, (_, index) => [`owner${index}/repo`, true]),
  );
  let persisted;
  const tracker = createReviewTracker({
    load: () => ({ version: 1, userLogin: 'octocat', prs, repoNeedsBaseline }),
    save: (state) => {
      persisted = structuredClone(state);
    },
  });
  tracker.setUser('octocat');
  tracker.markRepoForBaseline('new/repo');
  tracker.syncFromStorage({ version: 1, userLogin: 'octocat', prs: {}, repoNeedsBaseline: {} });
  assert.deepEqual(tracker.getUnreadIds('example/project', 7), ['memory-only']);
});

test('baseline flags remain usable when tracker storage reads and writes fail', () => {
  const tracker = createReviewTracker({
    load: () => {
      throw new Error('storage unavailable');
    },
    save: () => {
      throw new Error('storage unavailable');
    },
  });
  tracker.setUser('octocat');
  tracker.observeRepo(repo([], { paused: true }), { sequence: 1 });
  tracker.syncFromStorage({ version: 1, userLogin: 'octocat', prs: {}, repoNeedsBaseline: {} });

  assert.deepEqual(tracker.observeRepo(repo([pr(7, [event('baseline')])]), { sequence: 2 }), []);
  assert.deepEqual(
    tracker
      .observeRepo(repo([pr(7, [event('baseline'), event('after-resume', t1)])]), { sequence: 3 })
      .map((item) => item.id),
    ['after-resume'],
  );

  assert.equal(Object.keys(persisted.prs).length, 500);
  assert.equal(Object.keys(persisted.repoNeedsBaseline).length, 500);
  const first = Object.values(persisted.prs)[0];
  assert.equal(first.seenIds.length, 100);
  assert.equal(first.unread.length, 250);
});
        readAcks: Array.from({ length: 1000 }, (_unused, id) => ({ id: `read-${id}`, at: id })),
  assert.equal(first.readAcks.length, 500);
