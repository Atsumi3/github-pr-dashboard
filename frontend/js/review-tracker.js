const VERSION = 1;
const MAX_TRACKED_PRS = 500;
const MAX_SEEN_IDS_PER_PR = 100;
const MAX_WATERMARK_IDS = 100;
const MAX_UNREAD_EVENTS = 250;
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
    state.prs[key] = record;
  }

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
    let saved;
    try {
      saved = load();
    } catch {
      saved = null;
    }
    state = sanitizeState(saved, nextLogin);
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
    if (!record || !Array.isArray(ids) || ids.length === 0) return 0;
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
    try {
      clearPersisted();
    } catch {
      // Ignore storage failures; the in-memory state is already cleared.
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
