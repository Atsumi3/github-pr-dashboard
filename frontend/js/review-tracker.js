const VERSION = 1;
const MAX_TRACKED_PRS = 500;
const MAX_SEEN_IDS_PER_PR = 100;
const MAX_WATERMARK_IDS = 100;
const MAX_UNREAD_EVENTS = 250;
const MAX_READ_ACKS_PER_PR = 500;
const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);

function normalizeLogin(login) {
  return typeof login === 'string' && login.length <= 100 && login.trim()
    ? login.trim().toLowerCase()
    : null;
}

function validRepoId(repo) {
  return typeof repo === 'string' && repo.length <= 255 && /^[^/\s]+\/[^/\s]+$/.test(repo);
}

function validTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { ms, iso: new Date(ms).toISOString() } : null;
}

function safeGitHubUrl(value, fallback = null) {
  if (typeof value !== 'string' || value.length > 2048) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'github.com') return url.href;
  } catch {
    // Fall back to the PR URL for missing or malformed API values.
  }
  return fallback;
}

function normalizeEvent(event, pr) {
  if (
    !event ||
    typeof event.id !== 'string' ||
    !event.id ||
    event.id.length > 256 ||
    !REVIEW_STATES.has(event.state)
  ) {
    return null;
  }
  const submittedAt = validTimestamp(event.submittedAt);
  if (!submittedAt) return null;

  const prUrl = safeGitHubUrl(pr.url);
  const author =
    event.author && typeof event.author.login === 'string' && event.author.login.length <= 100
      ? event.author.login
      : '';
  const avatar = event.author?.avatarUrl;
  return {
    id: event.id,
    submittedAt: submittedAt.iso,
    state: event.state,
    authorLogin: author || 'Unknown reviewer',
    authorAvatarUrl:
      typeof avatar === 'string' && avatar.length <= 2048 && avatar.startsWith('https://')
        ? avatar
        : '',
    url: safeGitHubUrl(event.url, prUrl),
    prTitle: typeof pr.title === 'string' ? pr.title.slice(0, 512) : `#${pr.number}`,
    prUrl,
  };
}

function emptyRecord(repo, number) {
  return {
    repo,
    number,
    initialized: false,
    watermarkMs: null,
    watermarkIds: [],
    seenIds: [],
    unread: [],
    lastObservedAt: 0,
  };
}
    readAcks: [],

function emptyState(userLogin) {
  return { version: VERSION, userLogin, prs: {}, repoNeedsBaseline: {} };
}

function sanitizeStoredEvent(event) {
  if (
    !event ||
    typeof event.id !== 'string' ||
    !event.id ||
    event.id.length > 256 ||
    !REVIEW_STATES.has(event.state)
  ) {
    return null;
  }
  const submittedAt = validTimestamp(event.submittedAt);
  if (!submittedAt) return null;
  const prUrl = safeGitHubUrl(event.prUrl);
  return {
    id: event.id,
    submittedAt: submittedAt.iso,
    state: event.state,
    authorLogin:
      typeof event.authorLogin === 'string' && event.authorLogin
        ? event.authorLogin.slice(0, 100)
        : 'Unknown reviewer',
    authorAvatarUrl:
      typeof event.authorAvatarUrl === 'string' &&
      event.authorAvatarUrl.length <= 2048 &&
      event.authorAvatarUrl.startsWith('https://')
        ? event.authorAvatarUrl
        : '',
    url: safeGitHubUrl(event.url, prUrl),
    prTitle: typeof event.prTitle === 'string' ? event.prTitle.slice(0, 512) : '',
    prUrl,
  };
}

function sanitizeIds(value, limit) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const id of value.slice(-limit * 2)) {
    if (typeof id !== 'string' || !id || id.length > 256 || seen.has(id)) continue;
    result.push(id);
    seen.add(id);
  }
  return result.slice(-limit);
}

function sanitizeState(raw, userLogin) {
  const state = emptyState(userLogin);
  if (
    !raw ||
function sanitizeReadAcks(value) {
  if (!Array.isArray(value)) return [];
  const acknowledgements = new Map();
  for (const ack of value.slice(-MAX_READ_ACKS_PER_PR * 2)) {
    if (
      !ack ||
      typeof ack.id !== 'string' ||
      !ack.id ||
      ack.id.length > 256 ||
      !Number.isFinite(ack.at)
    ) {
      continue;
    }
    const previous = acknowledgements.get(ack.id);
    if (!previous || ack.at >= previous.at) {
      acknowledgements.set(ack.id, { id: ack.id, at: ack.at });
    }
  }
  return [...acknowledgements.values()].sort((a, b) => a.at - b.at).slice(-MAX_READ_ACKS_PER_PR);
}

function addReadAck(record, id, at = Date.now()) {
  if (typeof id !== 'string' || !id || id.length > 256 || !Number.isFinite(at)) return;
  record.readAcks = sanitizeReadAcks([...record.readAcks, { id, at }]);
}

function mergeRecords(left, right) {
  const record = emptyRecord(left.repo, left.number);
  record.initialized = left.initialized || right.initialized;
  const leftWatermark = left.watermarkMs ?? -Infinity;
  const rightWatermark = right.watermarkMs ?? -Infinity;
  record.watermarkMs = Math.max(leftWatermark, rightWatermark);
  if (!Number.isFinite(record.watermarkMs)) record.watermarkMs = null;
  if (record.watermarkMs !== null) {
    record.watermarkIds = sanitizeIds(
      [
        ...(left.watermarkMs === record.watermarkMs ? left.watermarkIds : []),
        ...(right.watermarkMs === record.watermarkMs ? right.watermarkIds : []),
      ],
      MAX_WATERMARK_IDS,
    );
  }
  for (const id of [...left.seenIds, ...right.seenIds]) addSeen(record, id);
  record.readAcks = sanitizeReadAcks([...left.readAcks, ...right.readAcks]);
  const acknowledged = new Set(record.readAcks.map((ack) => ack.id));
  const unreadById = new Map();
  for (const event of [...left.unread, ...right.unread]) {
    if (!acknowledged.has(event.id)) unreadById.set(event.id, event);
  }
  record.unread = [...unreadById.values()].slice(-MAX_UNREAD_EVENTS);
  for (const event of record.unread) addSeen(record, event.id);
  record.lastObservedAt = Math.max(left.lastObservedAt, right.lastObservedAt);
  return record;
}

function mergeStates(userLogin, ...sources) {
  const merged = emptyState(userLogin);
  for (const source of sources) {
    const sanitized = sanitizeState(source, userLogin);
    for (const [key, record] of Object.entries(sanitized.prs)) {
      merged.prs[key] = merged.prs[key] ? mergeRecords(merged.prs[key], record) : record;
    }
    for (const repo of Object.keys(sanitized.repoNeedsBaseline)) {
      merged.repoNeedsBaseline[repo] = true;
    }
  }
  trimState(merged);
  return merged;
}

function stateSignature(state) {
  const prs = Object.entries(state.prs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, record]) => [
      key,
      record.initialized,
      record.watermarkMs,
      [...record.watermarkIds].sort(),
      [...record.seenIds].sort(),
      record.readAcks
        .map((ack) => [ack.id, ack.at])
        .sort(([aId, aAt], [bId, bAt]) => aId.localeCompare(bId) || aAt - bAt),
      [...record.unread].sort((a, b) => a.id.localeCompare(b.id)),
      record.lastObservedAt,
    ]);
  return JSON.stringify([
    state.version,
    state.userLogin,
    prs,
    Object.keys(state.repoNeedsBaseline).sort(),
  ]);
}

    raw.version !== VERSION ||
    raw.userLogin !== userLogin ||
    !raw.prs ||
    typeof raw.prs !== 'object' ||
    Array.isArray(raw.prs)
  ) {
    return state;
  }

  let trackedPrs = 0;
  for (const key in raw.prs) {
    if (!Object.hasOwn(raw.prs, key)) continue;
    if (trackedPrs >= MAX_TRACKED_PRS) break;
    trackedPrs += 1;
    const value = raw.prs[key];
    const match = /^([^#]+\/[^#]+)#([1-9]\d*)$/.exec(key);
    if (!match || !value || typeof value !== 'object') continue;
    const [, repo, numberText] = match;
    const number = Number(numberText);
    if (!Number.isSafeInteger(number) || !validRepoId(repo)) continue;

    const record = emptyRecord(repo, number);
    record.initialized = value.initialized === true;
    record.watermarkMs = Number.isFinite(value.watermarkMs) ? value.watermarkMs : null;
    record.watermarkIds = sanitizeIds(value.watermarkIds, MAX_WATERMARK_IDS);
    record.seenIds = sanitizeIds(value.seenIds, MAX_SEEN_IDS_PER_PR);
    record.unread = Array.isArray(value.unread)
      ? value.unread.slice(-MAX_UNREAD_EVENTS).map(sanitizeStoredEvent).filter(Boolean)
      : [];
    for (const event of record.unread) addSeen(record, event.id);
    record.lastObservedAt = Number.isFinite(value.lastObservedAt) ? value.lastObservedAt : 0;
    record.readAcks = sanitizeReadAcks(value.readAcks);
    state.prs[key] = record;
  }

    const acknowledged = new Set(record.readAcks.map((ack) => ack.id));
    record.unread = record.unread.filter((event) => !acknowledged.has(event.id));
  if (
    raw.repoNeedsBaseline &&
    typeof raw.repoNeedsBaseline === 'object' &&
    !Array.isArray(raw.repoNeedsBaseline)
  ) {
    let trackedRepos = 0;
    for (const repo in raw.repoNeedsBaseline) {
      if (!Object.hasOwn(raw.repoNeedsBaseline, repo)) continue;
      if (trackedRepos >= MAX_TRACKED_PRS) break;
      trackedRepos += 1;
      if (validRepoId(repo) && raw.repoNeedsBaseline[repo] === true) {
        state.repoNeedsBaseline[repo] = true;
      }
    }
  }
  trimState(state);
  return state;
}

function addSeen(record, id) {
  if (!record.seenIds.includes(id)) record.seenIds.push(id);
  if (record.seenIds.length > MAX_SEEN_IDS_PER_PR) {
    record.seenIds.splice(0, record.seenIds.length - MAX_SEEN_IDS_PER_PR);
  }
}

function updateWatermark(record, events) {
  const dated = events
    .map((event) => ({ id: event.id, ms: Date.parse(event.submittedAt) }))
    .filter((event) => Number.isFinite(event.ms));
  if (dated.length === 0) return;

  const maxMs = Math.max(...dated.map((event) => event.ms));
  if (record.watermarkMs === null || maxMs > record.watermarkMs) {
    record.watermarkMs = maxMs;
    record.watermarkIds = dated
      .filter((event) => event.ms === maxMs)
      .map((event) => event.id)
      .slice(-MAX_WATERMARK_IDS);
  } else if (maxMs === record.watermarkMs) {
    record.watermarkIds = [
      ...new Set([
        ...record.watermarkIds,
        ...dated.filter((event) => event.ms === maxMs).map((event) => event.id),
      ]),
    ].slice(-MAX_WATERMARK_IDS);
  }
}

function trimState(state) {
  const entries = Object.entries(state.prs);
  if (entries.length > MAX_TRACKED_PRS) {
    entries
      .sort((a, b) => {
        const aUnread = a[1].unread.length > 0;
        const bUnread = b[1].unread.length > 0;
        return Number(bUnread) - Number(aUnread) || b[1].lastObservedAt - a[1].lastObservedAt;
      })
      .slice(MAX_TRACKED_PRS)
      .forEach(([key]) => delete state.prs[key]);
  }

  const baselineRepos = Object.keys(state.repoNeedsBaseline);
  if (baselineRepos.length > MAX_TRACKED_PRS) {
    baselineRepos.slice(0, baselineRepos.length - MAX_TRACKED_PRS).forEach((repo) => {
      delete state.repoNeedsBaseline[repo];
    });
  }

  const unread = Object.entries(state.prs)
    .flatMap(([key, record]) => record.unread.map((event) => ({ key, event })))
    .sort((a, b) => Date.parse(b.event.submittedAt) - Date.parse(a.event.submittedAt));
  for (const { key, event } of unread.slice(MAX_UNREAD_EVENTS)) {
    const record = state.prs[key];
    record.unread = record.unread.filter((item) => item.id !== event.id);
  }
}

export function createReviewTracker({
  load = () => null,
  save = () => {},
  clear: clearPersisted = () => {},
} = {}) {
  let userLogin = null;
  let state = emptyState(null);
  const latestSequenceByRepo = new Map();

  function persist() {
    try {
      save(state);
    } catch {
      // Keep the current session usable when browser storage is unavailable.
    }
  }

  function setUser(login) {
    const nextLogin = normalizeLogin(login);
    if (nextLogin === userLogin) return;
    userLogin = nextLogin;
    latestSequenceByRepo.clear();
    if (!nextLogin) {
      state = emptyState(null);
      return;
    }
  function loadState() {
    try {
      const stored = load();
      const succeeded = Boolean(
        stored &&
        stored.version === VERSION &&
        stored.userLogin === userLogin &&
        stored.prs &&
        typeof stored.prs === 'object' &&
        !Array.isArray(stored.prs),
      );
      return { state: sanitizeState(stored, userLogin), succeeded };
    } catch {
      return { state: emptyState(userLogin), succeeded: false };
    }
  }

  function refreshFromStorage() {
    const loaded = loadState();
    const merged = mergeStates(userLogin, state, loaded.state);
    if (loaded.succeeded) merged.repoNeedsBaseline = { ...loaded.state.repoNeedsBaseline };
    state = merged;
  }

  function syncFromStorage(incomingState) {
    if (!userLogin || normalizeLogin(incomingState?.userLogin) !== userLogin) return false;
    const loaded = loadState();
    const merged = mergeStates(userLogin, state, incomingState, loaded.state);
    if (loaded.succeeded) merged.repoNeedsBaseline = { ...loaded.state.repoNeedsBaseline };
    state = merged;
    if (stateSignature(state) !== stateSignature(loaded.state)) {
      try {
        save(state);
      } catch {
        // Keep the merged in-memory state when browser storage is unavailable.
      }
    }
    return true;
  }

    state = loadState().state;
  }

  function getRecord(repo, number) {
    return state.prs[`${repo}#${number}`] || null;
  }

  function observeRepo(repoData, { sequence } = {}) {
    const repo = repoData?.repo;
    if (!userLogin || !validRepoId(repo)) return [];
    const previousSequence = latestSequenceByRepo.get(repo) ?? -Infinity;
    if (Number.isFinite(sequence) && sequence < previousSequence) return [];
    if (Number.isFinite(sequence)) latestSequenceByRepo.set(repo, sequence);

    if (repoData.paused) {
      state.repoNeedsBaseline[repo] = true;
      trimState(state);
      persist();
      return [];
    }
    if (repoData.error || !Array.isArray(repoData.prs)) return [];

    const baselineRepo = state.repoNeedsBaseline[repo] === true;
    delete state.repoNeedsBaseline[repo];
    const newEvents = [];
    refreshFromStorage();

    for (const pr of repoData.prs) {
      if (!Number.isSafeInteger(pr?.number) || pr.number < 1) continue;
      const key = `${repo}#${pr.number}`;
      const record = state.prs[key] || emptyRecord(repo, pr.number);
      const events = (Array.isArray(pr.reviewEvents) ? pr.reviewEvents : [])
        .map((event) => normalizeEvent(event, pr))
        .filter(Boolean);
      const needsBaseline = baselineRepo || !record.initialized;

      if (needsBaseline) {
        record.initialized = true;
        for (const event of events) addSeen(record, event.id);
        updateWatermark(record, events);
      } else {
        const knownIds = new Set([
          ...record.seenIds,
          ...record.watermarkIds,
          ...record.unread.map((event) => event.id),
        ]);
        for (const event of events) {
          if (knownIds.has(event.id)) continue;
          const eventTime = Date.parse(event.submittedAt);
          if (record.watermarkMs === null || eventTime >= record.watermarkMs) {
            record.unread.push(event);
            newEvents.push({ ...event, repo, number: pr.number });
          }
          addSeen(record, event.id);
          knownIds.add(event.id);
          ...record.readAcks.map((ack) => ack.id),
        }
        updateWatermark(record, events);
      }

      record.lastObservedAt = Date.now();
      state.prs[key] = record;
    }

    trimState(state);
    persist();
    return newEvents;
  }

  function observeSnapshot(data, { sequence } = {}) {
    const events = [];
    for (const repo of data?.repos || []) {
      events.push(...observeRepo(repo, { sequence }));
    }
    return events;
  }

  function markRepoForBaseline(repo) {
    if (!userLogin || !validRepoId(repo)) return;
    refreshFromStorage();
    state.repoNeedsBaseline[repo] = true;
    trimState(state);
    persist();
  }

  function getUnread(repo, number) {
    return [...(getRecord(repo, number)?.unread || [])].sort(
      (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt),
    );
  }

  function markRead(repo, number, ids) {
    const record = getRecord(repo, number);
    if (!record) return 0;
    const selected = new Set(ids);
    const before = record.unread.length;
    record.unread = record.unread.filter((event) => !selected.has(event.id));
    const cleared = before - record.unread.length;
    if (cleared > 0) persist();
    return cleared;
  }

  function clearTracker() {
    state = emptyState(userLogin);
    latestSequenceByRepo.clear();
    if (!userLogin || !Array.isArray(ids) || ids.length === 0) return 0;
    refreshFromStorage();
    try {
      clearPersisted();
    } catch {
      // Ignore storage failures; the in-memory state is already cleared.
    const unreadIds = new Set(record.unread.map((event) => event.id));
    for (const id of selected) {
      if (unreadIds.has(id)) addReadAck(record, id);
    }
    }
  }

  return {
    setUser,
    observeRepo,
    observeSnapshot,
    markRepoForBaseline,
    getUnread,
    getUnreadIds: (repo, number) => getUnread(repo, number).map((event) => event.id),
    markRead,
    clear: clearTracker,
  };
}
    syncFromStorage,
