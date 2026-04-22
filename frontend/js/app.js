import { api, getStoredToken, clearStoredToken, invalidateApiSwCache } from './api.js';
import {
  initSidebar,
  renderRepoList,
  initSettings,
  initAiPanel,
  refreshAiPanel,
  isAiAvailable,
  onAiAvailabilityChange,
  showToast,
  confirmDialog,
  cleanupLegacyStorage,
} from './settings.js';
import { readCache, writeCache, CACHE_KEYS, readAiSummary, writeAiSummary } from './local-cache.js';

// Active = polling AND visible — the unified state ships from backend as
// `paused`, and lastData is the only place the UI reads it from. Defaults
// to true before the first /api/prs lands so freshly-added repos aren't
// accidentally hidden during the bootstrap window.
function isRepoActive(repoId) {
  const repo = lastData?.repos?.find((r) => r.repo === repoId);
  if (!repo) return true;
  return !repo.paused;
}

let pollTimer = null;
let lastDetailTrigger = null; // restore focus to this element when detail pane closes
let hasRunInitialScan = false;
let previousPRState = null; // Map of "repo#number" -> { reviewStatus, exists }
let lastFetchAt = 0; // timestamp (ms) of the most recent loadPRs() invocation
let lastData = null; // most recent /api/prs response, kept for client-side re-render
const VISIBILITY_REFETCH_THRESHOLD = 30_000; // skip immediate refetch if within 30s

function rerenderFromLastData() {
  if (!lastData?.repos) return;
  const main = document.getElementById('pr-content');
  reconcileRepoSections(main, lastData.repos);
  lastRenderSig = renderSignature(lastData);
  reapplySearchFilter();
}

function reapplySearchFilter() {
  const input = document.getElementById('pr-search');
  if (!input || !input.value.trim()) return;
  applySearchFilter();
}

function ensureSearchEmptyState(query, totalVisible) {
  const main = document.getElementById('pr-content');
  if (!main) return;
  let empty = main.querySelector('.search-empty-state');
  if (query && totalVisible === 0) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'search-empty-state';
      main.appendChild(empty);
    }
    empty.textContent = `No PRs match “${query}”`;
  } else if (empty) {
    empty.remove();
  }
}

function applySearchFilter() {
  const input = document.getElementById('pr-search');
  if (!input) return;
  const q = input.value.trim();
  const lower = q.toLowerCase();
  const cards = document.querySelectorAll('.pr-card');
  const visibleByRepo = new Map();
  cards.forEach((card) => {
    const matches = !lower || (card.dataset.search || '').includes(lower);
    const next = matches ? '' : 'none';
    if (card.style.display !== next) card.style.display = next;
    highlightTitle(card, matches ? q : '');
    const repoId = card.closest('.repo-section')?.dataset.repo;
    if (repoId && matches) visibleByRepo.set(repoId, (visibleByRepo.get(repoId) || 0) + 1);
  });
  let totalVisible = 0;
  document.querySelectorAll('.repo-section').forEach((section) => {
    const repoId = section.dataset.repo;
    const visibleCount = visibleByRepo.get(repoId) || 0;
    // Sections for paused repos shouldn't even exist after reconcile, but
    // we also defend here in case a search runs against a stale DOM.
    const showSection = visibleCount > 0 && isRepoActive(repoId);
    const next = showSection ? '' : 'none';
    if (section.style.display !== next) section.style.display = next;
    if (showSection) totalVisible += visibleCount;
  });
  ensureSearchEmptyState(q, totalVisible);
}

// Wrap matched query in <mark> inside the PR title. Restore plain title when
// query is empty. We work off card.dataset.title (set during render) so we
// always know the original text — querying current textContent would compound
// previous mark wrappings.
function highlightTitle(card, query) {
  const titleEl = card.querySelector('.pr-title');
  if (!titleEl) return;
  const original = card.dataset.title;
  if (!original) return;
  if (!query) {
    if (titleEl.firstElementChild) titleEl.textContent = original;
    return;
  }
  const lower = original.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) {
    if (titleEl.firstElementChild) titleEl.textContent = original;
    return;
  }
  while (titleEl.firstChild) titleEl.firstChild.remove();
  if (idx > 0) titleEl.append(document.createTextNode(original.slice(0, idx)));
  const mark = document.createElement('mark');
  mark.textContent = original.slice(idx, idx + query.length);
  titleEl.append(mark);
  if (idx + query.length < original.length) {
    titleEl.append(document.createTextNode(original.slice(idx + query.length)));
  }
}

// Subtle pulse on the "Updated Xs ago" indicator dot whenever a successful
// poll round-trip lands. Keeps the user oriented during the long-running
// session without redrawing card content (which the user explicitly didn't
// want to see flicker on every poll).
let justUpdatedTimer = null;
function flashJustUpdated() {
  const el = document.getElementById('last-updated');
  if (!el) return;
  el.classList.remove('just-updated');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('just-updated');
  if (justUpdatedTimer) clearTimeout(justUpdatedTimer);
  justUpdatedTimer = setTimeout(() => el.classList.remove('just-updated'), 700);
}

function updateLastUpdatedDisplay() {
  const el = document.getElementById('last-updated');
  if (!el) return;
  if (!lastFetchAt) {
    el.textContent = '--';
    return;
  }
  const diff = Math.floor((Date.now() - lastFetchAt) / 1000);
  let text;
  if (diff < 5) text = 'Updated just now';
  else if (diff < 60) text = `Updated ${diff}s ago`;
  else if (diff < 3600) text = `Updated ${Math.floor(diff / 60)}m ago`;
  else text = `Updated ${Math.floor(diff / 3600)}h ago`;
  el.textContent = text;
}

let lastUpdatedTimer = null;

function startLastUpdatedTimer() {
  if (lastUpdatedTimer) return;
  lastUpdatedTimer = setInterval(updateLastUpdatedDisplay, 1000);
}

function stopLastUpdatedTimer() {
  if (lastUpdatedTimer) {
    clearInterval(lastUpdatedTimer);
    lastUpdatedTimer = null;
  }
}

startLastUpdatedTimer();

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendNotification(title, body, url) {
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body });
    if (url) {
      n.onclick = () => {
        window.open(url, '_blank');
        n.close();
      };
    }
    setTimeout(() => n.close(), 10000);
  }
}

function detectChangesAndNotify(newData) {
  if (!newData || !newData.repos) return;
  if (!previousPRState) {
    // First load: build state without notifying
    previousPRState = new Map();
    for (const repo of newData.repos) {
      for (const pr of repo.prs) {
        previousPRState.set(`${repo.repo}#${pr.number}`, pr.reviewStatus);
      }
    }
    return;
  }

  const newState = new Map();
  for (const repo of newData.repos) {
    for (const pr of repo.prs) {
      const key = `${repo.repo}#${pr.number}`;
      newState.set(key, pr.reviewStatus);

      const oldStatus = previousPRState.get(key);
      if (oldStatus === undefined) {
        // New PR opened
        sendNotification(`New PR: ${repo.repo}`, `#${pr.number} ${pr.title}`, pr.url);
      } else if (oldStatus !== pr.reviewStatus) {
        // Status changed
        sendNotification(
          `Status changed: ${repo.repo} #${pr.number}`,
          `${oldStatus} -> ${pr.reviewStatus}`,
          pr.url,
        );
      }
    }
  }

  previousPRState = newState;
}

function setLoading(active, message = 'Loading...') {
  const overlay = document.getElementById('loading-overlay');
  const text = document.getElementById('loading-text');
  if (!overlay) return;
  if (active) {
    if (text) text.textContent = message;
    overlay.classList.remove('hidden');
    document.body.classList.add('loading');
  } else {
    overlay.classList.add('hidden');
    document.body.classList.remove('loading');
  }
}

function relativeTime(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const REVIEW_BADGES = {
  APPROVED: { cls: 'badge-approved', icon: '\u2713', label: 'Approved' },
  CHANGES_REQUESTED: { cls: 'badge-changes', icon: '\u2717', label: 'Changes Requested' },
  PENDING: { cls: 'badge-pending', icon: '\u25F7', label: 'Pending' },
  REVIEW_REQUIRED: { cls: 'badge-review', icon: '\u269F', label: 'Review Required' },
};

// ============================
// Sort
// ============================
const SORT_KEY_STORAGE = 'pr-dashboard-sort';
const STATUS_PRIORITY = { CHANGES_REQUESTED: 0, REVIEW_REQUIRED: 1, PENDING: 2, APPROVED: 3 };

// Display limit per repo for "Load more" button
const INITIAL_DISPLAY_LIMIT = 10;
const LOAD_MORE_INCREMENT = 10;
const displayLimit = new Map();

function renderCardsInGrid(grid, sortedPrs, limit) {
  while (grid.firstChild) grid.firstChild.remove();
  sortedPrs.slice(0, limit).forEach((pr) => grid.appendChild(renderPRCard(pr)));
}

function getSortKey() {
  return localStorage.getItem(SORT_KEY_STORAGE) || 'status';
}

function setSortKey(key) {
  localStorage.setItem(SORT_KEY_STORAGE, key);
}

function sortPRs(prs, key) {
  const me = window.__ME__;
  const reviewedByMe = (pr) => {
    if (!me) return false;
    const myReview = pr.reviews && pr.reviews.some((r) => r.login === me);
    const isReReq = pr.requestedReviewers && pr.requestedReviewers.some((r) => r.login === me);
    return myReview && !isReReq;
  };

  return [...prs].sort((a, b) => {
    // Draft always last
    if (a.draft !== b.draft) return a.draft ? 1 : -1;
    // Reviewed-by-me PRs go to bottom (above draft)
    const ar = reviewedByMe(a);
    const br = reviewedByMe(b);
    if (ar !== br) return ar ? 1 : -1;

    if (key === 'updated') {
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    }
    if (key === 'created') {
      return new Date(b.createdAt) - new Date(a.createdAt);
    }
    if (key === 'behind') {
      const ab = typeof a.behindBy === 'number' ? a.behindBy : -1;
      const bb = typeof b.behindBy === 'number' ? b.behindBy : -1;
      if (ab !== bb) return bb - ab;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    }
    // default: status
    const sa = STATUS_PRIORITY[a.reviewStatus] ?? 9;
    const sb = STATUS_PRIORITY[b.reviewStatus] ?? 9;
    if (sa !== sb) return sa - sb;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}

const FALLBACK_AVATAR_SVG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect fill="#555" width="20" height="20" rx="10"/></svg>',
  );

function isSafeAvatarUrl(url) {
  return typeof url === 'string' && url.startsWith('https://');
}

function createAvatar(url, size = 20) {
  const img = document.createElement('img');
  img.className = size === 20 ? 'avatar-sm' : 'avatar';
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = () => {
    img.style.background = '#555';
    img.src = FALLBACK_AVATAR_SVG;
  };
  if (isSafeAvatarUrl(url)) {
    img.src = url;
  } else {
    // Reject http://, javascript:, data:, relative paths, etc.
    img.style.background = '#555';
    img.src = FALLBACK_AVATAR_SVG;
  }
  return img;
}

function renderPRCard(pr) {
  const card = document.createElement('div');
  let cardClass = 'pr-card';

  // Apply review status as primary color theme
  const statusClassMap = {
    APPROVED: ' pr-status-approved',
    CHANGES_REQUESTED: ' pr-status-changes',
    PENDING: ' pr-status-pending',
    REVIEW_REQUIRED: ' pr-status-review',
  };
  cardClass += statusClassMap[pr.reviewStatus] || '';

  if (pr.draft) cardClass += ' pr-draft';
  else if (pr.state === 'merged') cardClass += ' pr-merged';
  else if (pr.state === 'closed') cardClass += ' pr-closed';

  // My review status
  const me = window.__ME__;
  const myReview = me && pr.reviews ? pr.reviews.filter((r) => r.login === me) : [];
  const isReReviewRequested =
    me && pr.requestedReviewers && pr.requestedReviewers.some((r) => r.login === me);
  const hasReviewed = myReview.length > 0;

  if (hasReviewed && isReReviewRequested) cardClass += ' pr-rerequested';
  else if (hasReviewed) cardClass += ' pr-reviewed';

  card.className = cardClass;
  card.style.cursor = 'pointer';
  card.dataset.search =
    `${pr.title} ${pr.branch} ${pr.author?.login || ''} ${pr.assignees?.map((a) => a.login).join(' ') || ''} #${pr.number}`.toLowerCase();

  // Extract owner/repo from url (https://github.com/owner/repo/pull/123)
  const urlParts = pr.url.replace('https://github.com/', '').split('/');
  const prOwner = urlParts[0];
  const prRepo = urlParts[1];

  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `PR #${pr.number} ${pr.title}`);
  const openPane = (e) => {
    if (e.target.closest('a')) return; // Don't intercept link clicks
    lastDetailTrigger = card;
    openDetailPane(prOwner, prRepo, pr.number, pr.title);
  };
  card.addEventListener('click', openPane);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPane(e);
    }
  });

  // Row 1: number + title + created
  const row1 = document.createElement('div');
  row1.className = 'pr-row1';
  const row1Left = document.createElement('div');
  row1Left.className = 'pr-row1-left';
  const num = document.createElement('span');
  num.className = 'pr-number';
  num.textContent = `#${pr.number}`;
  // Title is intentionally not a hyperlink — clicking it should open the
  // in-app detail pane (which has its own "Open in GitHub" button), not
  // bounce the user out to github.com.
  const title = document.createElement('span');
  title.className = 'pr-title';
  title.textContent = pr.title;
  // Stash the original so highlightTitle can restore / re-mark without
  // accumulating <mark> wrappers across successive search keystrokes.
  card.dataset.title = pr.title;
  row1Left.append(num);
  if (pr.draft) {
    const draftTag = document.createElement('span');
    draftTag.className = 'pr-draft-tag';
    draftTag.textContent = 'Draft';
    row1Left.appendChild(draftTag);
  }
  if (hasReviewed && isReReviewRequested) {
    const tag = document.createElement('span');
    tag.className = 'pr-status-tag pr-tag-rerequest';
    tag.textContent = 'Re-review';
    row1Left.appendChild(tag);
  } else if (hasReviewed) {
    const tag = document.createElement('span');
    tag.className = 'pr-status-tag pr-tag-reviewed';
    tag.textContent = 'Reviewed';
    row1Left.appendChild(tag);
  }
  row1Left.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'pr-meta-icons';

  // Conflict icon
  if (pr.mergeable === false) {
    const conflict = document.createElement('span');
    conflict.className = 'pr-conflict-icon';
    conflict.textContent = '\u26A0';
    conflict.title = 'Has conflicts with base';
    meta.appendChild(conflict);
  }

  // Behind base branch
  if (typeof pr.behindBy === 'number' && pr.behindBy > 0) {
    const behind = document.createElement('span');
    behind.className = 'pr-behind-icon';
    if (pr.behindBy >= 50) behind.classList.add('strong');
    else if (pr.behindBy >= 10) behind.classList.add('mild');
    behind.textContent = `\u2193${pr.behindBy}`;
    behind.title = `${pr.behindBy} commits behind ${pr.baseBranch || 'base'}`;
    meta.appendChild(behind);
  }

  // CI status icon
  if (pr.ciStatus) {
    const ci = document.createElement('span');
    ci.className = 'pr-ci-icon';
    if (pr.ciStatus.state === 'success') {
      ci.classList.add('success');
      ci.textContent = '\u2713';
      ci.title = `CI passing (${pr.ciStatus.total})`;
    } else if (pr.ciStatus.state === 'failure' || pr.ciStatus.state === 'error') {
      ci.classList.add('failure');
      ci.textContent = '\u2717';
      ci.title = `CI failed`;
    } else if (pr.ciStatus.state === 'pending') {
      ci.classList.add('pending');
      ci.textContent = '\u25F7';
      ci.title = `CI pending`;
    }
    meta.appendChild(ci);
  }

  // Stale warning
  const ageDays = Math.floor(
    (Date.now() - new Date(pr.updatedAt).getTime()) / (1000 * 60 * 60 * 24),
  );
  if (ageDays >= 14) {
    const warn = document.createElement('span');
    warn.className = 'pr-stale-icon stale-strong';
    warn.textContent = '\u26A0';
    warn.title = `Stale: ${ageDays} days no update`;
    meta.appendChild(warn);
  } else if (ageDays >= 7) {
    const warn = document.createElement('span');
    warn.className = 'pr-stale-icon stale-mild';
    warn.textContent = '\u26A0';
    warn.title = `Inactive: ${ageDays} days no update`;
    meta.appendChild(warn);
  }

  const created = document.createElement('span');
  created.className = 'pr-created';
  created.textContent = relativeTime(pr.createdAt);
  meta.appendChild(created);

  row1.append(row1Left, meta);

  // Labels (between row1 and row2)
  const labelsContainer = renderLabels(pr.labels);

  // Row 2: branch + updated
  const row2 = document.createElement('div');
  row2.className = 'pr-row2';
  const branch = document.createElement('span');
  branch.className = 'pr-branch mono';
  branch.textContent = pr.branch;
  const updated = document.createElement('span');
  updated.className = 'pr-updated';
  updated.textContent = `Updated ${relativeTime(pr.updatedAt)}`;
  row2.append(branch, updated);

  // Row 3: author -> assignee + badge
  const row3 = document.createElement('div');
  row3.className = 'pr-row3';
  const row3Left = document.createElement('div');
  row3Left.className = 'pr-row3-left';

  const author = document.createElement('span');
  author.className = 'pr-author';
  author.append(createAvatar(pr.author.avatarUrl), document.createTextNode(` ${pr.author.login}`));

  const arrow = document.createElement('span');
  arrow.className = 'pr-arrow';
  arrow.textContent = '\u2192';

  row3Left.append(author, arrow);

  if (pr.assignees.length > 0) {
    pr.assignees.forEach((a) => {
      const assignee = document.createElement('span');
      assignee.className = 'pr-assignee';
      assignee.append(createAvatar(a.avatarUrl), document.createTextNode(` ${a.login}`));
      row3Left.appendChild(assignee);
    });
  } else {
    const noAssign = document.createElement('span');
    noAssign.className = 'pr-no-assignee';
    noAssign.textContent = 'Unassigned';
    row3Left.appendChild(noAssign);
  }

  const badgeInfo = REVIEW_BADGES[pr.reviewStatus] || REVIEW_BADGES.PENDING;
  const badge = document.createElement('span');
  badge.className = `badge ${badgeInfo.cls}`;
  const icon = document.createElement('span');
  icon.className = 'badge-icon';
  icon.textContent = badgeInfo.icon;

  const approvedCount = pr.reviews.filter((r) => r.state === 'APPROVED').length;
  const totalReviewers = pr.reviews.length;
  let badgeLabel = badgeInfo.label;
  if (totalReviewers > 0) {
    badgeLabel += ` ${approvedCount}/${totalReviewers}`;
  }
  badge.append(icon, document.createTextNode(` ${badgeLabel}`));

  row3.append(row3Left, badge);
  card.append(row1);
  if (labelsContainer) card.appendChild(labelsContainer);
  card.append(row2, row3);
  return card;
}

const MAX_VISIBLE_LABELS = 3;

function renderLabels(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return null;
  const container = document.createElement('div');
  container.className = 'pr-labels';
  const visible = labels.slice(0, MAX_VISIBLE_LABELS);
  visible.forEach((l) => container.appendChild(createLabelChip(l)));
  if (labels.length > MAX_VISIBLE_LABELS) {
    const more = document.createElement('span');
    more.className = 'pr-label pr-label-more';
    more.textContent = `+${labels.length - MAX_VISIBLE_LABELS} more`;
    more.title = labels
      .slice(MAX_VISIBLE_LABELS)
      .map((l) => l.name)
      .join(', ');
    container.appendChild(more);
  }
  return container;
}

function createLabelChip(label) {
  const chip = document.createElement('span');
  chip.className = 'pr-label';
  chip.textContent = label.name;
  const bg = isValidHex(label.color) ? label.color : '#888888';
  chip.style.backgroundColor = bg;
  chip.style.color = pickLabelTextColor(bg);
  return chip;
}

function isValidHex(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

function pickLabelTextColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Perceived luminance (sRGB approximation)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#000000' : '#ffffff';
}

// Map a backend repo-fetch error into a human label that makes the cause
// obvious. The previous "Repository inaccessible" was misleading because
// GitHub-side 5xx (transient) and 4xx (real permission problems) both produced
// the same message — users assumed they had a permission issue when GitHub was
// just being flaky.
function describeRepoError(error) {
  if (!error) return null;
  // Backwards compat: error used to be a bare string.
  const message = typeof error === 'string' ? error : error.message;
  const status = typeof error === 'object' ? error.status : null;
  if (status === 401) {
    return {
      tag: 'Auth error',
      body: '認証に失敗しました',
      severity: 'permanent',
      tooltip: message,
    };
  }
  if (status === 403) {
    // GitHub returns 403 for both rate limit AND permission errors (SAML SSO
    // not authorised, scope missing). Sniff the error message to tell them
    // apart since the backend doesn't currently parse X-RateLimit-Remaining.
    const isRate = /rate.?limit/i.test(message || '');
    return {
      tag: isRate ? 'Rate limited' : 'Forbidden',
      body: isRate
        ? 'GitHub のレート制限に達しています'
        : 'このリポジトリへのアクセスが拒否されました (scope / SSO を確認してください)',
      severity: isRate ? 'transient' : 'permanent',
      tooltip: message,
    };
  }
  if (status === 404) {
    return {
      tag: 'Not found',
      body: 'リポジトリが見つからないか、アクセス権がありません',
      severity: 'permanent',
      tooltip: message,
    };
  }
  if (status >= 500 && status < 600) {
    // The backend's gqlWithRetry already retried 3x; what the user sees here
    // is the post-retry state. Don't promise more retries — point them at the
    // per-repo refresh button instead.
    return {
      tag: 'GitHub error',
      body: `GitHub が一時的に応答していません (HTTP ${status})。右上の ⟳ ボタンで再取得できます`,
      severity: 'transient',
      tooltip: message,
    };
  }
  return {
    tag: 'Fetch error',
    body: message || 'PR 取得に失敗',
    severity: 'permanent',
    tooltip: message,
  };
}

function renderRepoSection(repoData) {
  const section = document.createElement('div');
  section.className = 'repo-section';
  section.dataset.repo = repoData.repo;
  // Paused now means hidden too; reconcileRepoSections also drops them, but
  // direct callers (loadSingleRepo, etc.) use this path so we keep the guard.
  if (repoData.paused) section.style.display = 'none';

  const header = document.createElement('div');
  header.className = 'repo-header';
  const name = document.createElement('span');
  name.className = 'repo-name';
  name.textContent = repoData.repo;
  header.appendChild(name);

  const errorInfo = describeRepoError(repoData.error);
  if (errorInfo) {
    const warn = document.createElement('span');
    warn.className = 'repo-updated';
    warn.style.color = errorInfo.severity === 'transient' ? '#e6a23c' : '#d94452';
    warn.textContent = errorInfo.tag;
    warn.title = errorInfo.tooltip;
    header.appendChild(warn);
  }

  // Per-repo refresh — useful when one repo just hit a transient 5xx and
  // the user doesn't want to wait for the next poll or hit global refresh.
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'repo-refresh-btn';
  refreshBtn.title = `${repoData.repo} を再取得`;
  refreshBtn.setAttribute('aria-label', `Refresh ${repoData.repo}`);
  const svgNs = 'http://www.w3.org/2000/svg';
  const refreshSvg = document.createElementNS(svgNs, 'svg');
  refreshSvg.setAttribute('viewBox', '0 0 16 16');
  refreshSvg.setAttribute('width', '12');
  refreshSvg.setAttribute('height', '12');
  refreshSvg.setAttribute('fill', 'currentColor');
  refreshSvg.setAttribute('aria-hidden', 'true');
  const refreshPath = document.createElementNS(svgNs, 'path');
  refreshPath.setAttribute(
    'd',
    'M8 2.5a5.5 5.5 0 1 0 5.45 6.27.75.75 0 0 1 1.49.21A7 7 0 1 1 13 3.94V2.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.93A5.49 5.49 0 0 0 8 2.5z',
  );
  refreshSvg.appendChild(refreshPath);
  refreshBtn.appendChild(refreshSvg);
  refreshBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (refreshBtn.classList.contains('loading')) return;
    refreshBtn.classList.add('loading');
    try {
      await loadSingleRepo(repoData.repo);
    } finally {
      refreshBtn.classList.remove('loading');
    }
  });
  header.appendChild(refreshBtn);

  section.appendChild(header);

  if (repoData.prs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const p = document.createElement('p');
    p.textContent = errorInfo ? errorInfo.body : 'No open PRs';
    empty.appendChild(p);
    section.appendChild(empty);
  } else {
    const sorted = sortPRs(repoData.prs, getSortKey());
    const grid = document.createElement('div');
    grid.className = 'repo-cards';
    section.appendChild(grid);

    const limit = displayLimit.get(repoData.repo) || INITIAL_DISPLAY_LIMIT;
    renderCardsInGrid(grid, sorted, limit);

    if (sorted.length > limit) {
      const oldLimit = limit;
      const loadMore = document.createElement('button');
      loadMore.className = 'load-more-btn';
      loadMore.textContent = `Load more (${sorted.length - limit} more)`;
      loadMore.addEventListener('click', () => {
        const newLimit =
          (displayLimit.get(repoData.repo) || INITIAL_DISPLAY_LIMIT) + LOAD_MORE_INCREMENT;
        displayLimit.set(repoData.repo, newLimit);
        renderCardsInGrid(grid, sorted, newLimit);
        // Move keyboard focus to the first newly-revealed card so Tab order
        // doesn't snap back to the page top after the button vanishes.
        const cards = grid.querySelectorAll('.pr-card');
        const target = cards[oldLimit];
        if (target) target.focus();
        if (sorted.length > newLimit) {
          loadMore.textContent = `Load more (${sorted.length - newLimit} more)`;
        } else {
          loadMore.remove();
        }
      });
      section.appendChild(loadMore);
    }
  }

  return section;
}

async function loadSingleRepo(repoId) {
  const main = document.getElementById('pr-content');
  const [owner, name] = repoId.split('/');

  // Pause polling so a background loadPRs() doesn't blow away the loading
  // section (or the freshly-inserted real section) mid-fetch.
  const wasPolling = pollTimer !== null;
  if (wasPolling) stopPolling();

  const loadingSection = document.createElement('div');
  loadingSection.className = 'repo-section';
  loadingSection.dataset.repo = repoId;
  const header = document.createElement('div');
  header.className = 'repo-header';
  const nameEl = document.createElement('span');
  nameEl.className = 'repo-name';
  nameEl.textContent = repoId;
  header.appendChild(nameEl);
  const loadingTag = document.createElement('span');
  loadingTag.className = 'repo-loading-tag';
  loadingTag.textContent = 'Loading...';
  header.appendChild(loadingTag);
  loadingSection.appendChild(header);
  main.insertBefore(loadingSection, main.firstChild);

  try {
    const data = await api.prsForRepo(owner, name, true);
    loadingSection.remove();
    const repoData = {
      repo: data.repo,
      prs: data.prs,
      error: null,
      paused: lastDataPaused(repoId),
    };
    const newSection = renderRepoSection(repoData);
    // Replace the existing section in place if present (per-repo refresh path)
    // — without this, a second copy of the repo gets prepended and lingers
    // until the next full reconcile.
    const existing = main.querySelector(`.repo-section[data-repo="${CSS.escape(repoId)}"]`);
    if (existing) {
      existing.replaceWith(newSection);
    } else {
      main.insertBefore(newSection, main.firstChild);
    }
    upsertLastDataRepo(repoData);
    // Keep lastRenderSig in sync so the very next loadPRs() doesn't fall into
    // a redundant full reconcile when the polled data matches what we just
    // displayed.
    if (lastData) lastRenderSig = renderSignature(lastData);
    // Persist into localStorage so paintFromCache on next reload reflects the
    // freshly-fetched repo. The SW cache is bypassed for /api/prs/repo/...
    // anyway (different URL than /api/prs), so no SW invalidation needed.
    if (lastData) writeCache(CACHE_KEYS.prs, lastData);
    reapplySearchFilter();
    // Keep header counts in sync with what we just rendered — without this,
    // unpause→loadSingleRepo would leave stats stale until the next poll.
    updateStats(lastData);
  } catch (err) {
    loadingSection.remove();
    // Preserve previously-rendered PRs on failure — wiping to [] would hide
    // already-fetched content and leave the user staring at "Repository
    // inaccessible" even though we have perfectly good cached data.
    const prevPrs = lastData?.repos?.find((r) => r.repo === repoId)?.prs || [];
    const errored = {
      repo: repoId,
      prs: prevPrs,
      error: { message: err.message, status: err.status || null },
      paused: lastDataPaused(repoId),
    };
    upsertLastDataRepo(errored);
    // Re-render the section in place so the error tag shows up but the PR
    // cards stay visible.
    const newSection = renderRepoSection(errored);
    const existing = main.querySelector(`.repo-section[data-repo="${CSS.escape(repoId)}"]`);
    if (existing) existing.replaceWith(newSection);
    else main.insertBefore(newSection, main.firstChild);
    if (lastData) writeCache(CACHE_KEYS.prs, lastData);
    showToast(`Failed to load ${repoId}: ${err.message}`, 'error');
  } finally {
    if (wasPolling) startPolling({ skipImmediate: true });
  }
}

function lastDataPaused(repoId) {
  return lastData?.repos?.find((r) => r.repo === repoId)?.paused ?? false;
}

function upsertLastDataRepo(repoData) {
  if (!lastData?.repos) return;
  const idx = lastData.repos.findIndex((r) => r.repo === repoData.repo);
  if (idx >= 0) lastData.repos[idx] = repoData;
  else lastData.repos = [repoData, ...lastData.repos];
}

function removeLastDataRepo(repoId) {
  if (!lastData?.repos) return;
  lastData.repos = lastData.repos.filter((r) => r.repo !== repoId);
}

// Signature of the last rendered repo data + sort key. Used to skip the full
// DOM re-render when polling returns identical data (the common case when the
// backend cache is hit).
let lastRenderSig = null;

function repoSignature(r) {
  // Hash only the fields that affect rendering. Avoids stringifying the full
  // PR payload (reviews/labels/etc.) on every poll while still detecting any
  // change a user would visually perceive.
  return JSON.stringify({
    repo: r.repo,
    paused: r.paused,
    error: r.error,
    prs: (r.prs || []).map((pr) => [
      pr.number,
      pr.draft,
      pr.reviewStatus,
      pr.updatedAt,
      pr.behindBy ?? null,
      pr.commits?.[0]?.commit?.statusCheckRollup?.state,
      (pr.assignees || []).map((a) => a.login).join(','),
      (pr.requestedReviewers || []).map((r) => r.login).join(','),
      (pr.reviews || []).map((rv) => `${rv.login}:${rv.state}`).join(','),
      (pr.labels || []).map((l) => l.name).join(','),
    ]),
  });
}

function renderSignature(data) {
  return JSON.stringify((data?.repos || []).map(repoSignature)) + '|' + getSortKey();
}

async function loadPRs() {
  const main = document.getElementById('pr-content');
  try {
    const data = await api.prs(true);
    // Update lastFetchAt only on success — otherwise paintFromCache's stamp
    // gets overwritten with "now" while we're still showing stale data.
    lastFetchAt = Date.now();
    updateLastUpdatedDisplay();
    flashJustUpdated();
    // Successful round-trip — drop any "Server connection error" banner left
    // from a previous failure so the user isn't told we're still degraded.
    hideBanner();
    lastData = data;
    writeCache(CACHE_KEYS.prs, data);
    detectChangesAndNotify(data);
    updateStats(data);

    if (!data.repos || data.repos.length === 0) {
      while (main.firstChild) main.firstChild.remove();
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.style.marginTop = '80px';
      const p = document.createElement('p');
      p.textContent = 'Add repositories from the sidebar to start monitoring PRs';
      empty.appendChild(p);
      main.appendChild(empty);
      lastRenderSig = renderSignature(data);
      return;
    }

    const updatedText = document.getElementById('last-updated');
    if (updatedText && data.updatedAt) {
      updatedText.textContent = `Updated ${relativeTime(data.updatedAt)}`;
    }

    const sig = renderSignature(data);
    if (sig === lastRenderSig) {
      // Data hasn't changed — skip the DOM rebuild entirely.
      return;
    }
    lastRenderSig = sig;

    reconcileRepoSections(main, data.repos);
    reapplySearchFilter();
  } catch (err) {
    if (err.status === 401) {
      showToast('Session expired. Redirecting to login...', 'error');
      setTimeout(() => (window.location.href = '/setup.html'), 2000);
      return;
    }
    showBanner('Server connection error. Showing cached data.', 'warning');
  }
}

// Per-repo-section diff. Compares each desired repo against the existing DOM
// section by data-repo and signature; only replaces sections whose data has
// changed. Reorders/removes/adds as needed.
function reconcileRepoSections(main, desiredRepos) {
  // Paused repos are hidden from the dashboard entirely; the section never
  // gets created (saves DOM nodes, eliminates "is this visible?" branches in
  // every downstream consumer).
  desiredRepos = desiredRepos.filter((r) => !r.paused);
  const existingByRepo = new Map();
  for (const node of Array.from(main.children)) {
    const id = node.dataset?.repo;
    if (id) {
      // If two sections share the same data-repo (could happen if a transient
      // race left an orphan loadingSection from loadSingleRepo, or any past
      // bug), keep only the first and drop the rest. Self-healing — without
      // this, duplicates would persist until the user manually reloaded.
      if (existingByRepo.has(id)) {
        node.remove();
      } else {
        existingByRepo.set(id, node);
      }
    } else if (node.classList?.contains('search-empty-state')) {
      // Preserve the search empty-state placeholder; applySearchFilter owns it.
    } else {
      // Drop any stray non-section node (e.g. an .empty-state div left behind
      // when the dashboard transitions from "no repos" to "has repos").
      node.remove();
    }
  }

  const desiredIds = new Set(desiredRepos.map((r) => r.repo));
  for (const [id, node] of existingByRepo) {
    if (!desiredIds.has(id)) node.remove();
  }

  let prev = null;
  for (const repoData of desiredRepos) {
    const sig = repoSignature(repoData);
    let node = existingByRepo.get(repoData.repo);
    if (!node || node.dataset.sig !== sig) {
      const fresh = renderRepoSection(repoData);
      fresh.dataset.sig = sig;
      if (node) {
        node.replaceWith(fresh);
      } else if (prev) {
        prev.after(fresh);
      } else {
        main.insertBefore(fresh, main.firstChild);
      }
      node = fresh;
    } else {
      // Already in correct shape; just ensure DOM order matches desired order.
      const expectedNext = prev ? prev.nextSibling : main.firstChild;
      if (node !== expectedNext) {
        if (prev) prev.after(node);
        else main.insertBefore(node, main.firstChild);
      }
    }
    prev = node;
  }
}

// Last value for each header stat label. Used to detect changes between
// polls so we can flash only the value that actually changed.
const lastStatsValues = new Map();

function updateStats(data) {
  const el = document.getElementById('header-stats');
  if (!el) return;
  if (!data || !data.repos) {
    while (el.firstChild) el.firstChild.remove();
    return;
  }

  const me = window.__ME__;
  let total = 0;
  let needReview = 0;
  let mine = 0;
  let approved = 0;

  for (const repo of data.repos) {
    if (repo.paused) continue;
    for (const pr of repo.prs) {
      total += 1;
      if (pr.reviewStatus === 'REVIEW_REQUIRED' || pr.reviewStatus === 'CHANGES_REQUESTED') {
        needReview += 1;
      }
      if (pr.reviewStatus === 'APPROVED') approved += 1;
      if (me && pr.author && pr.author.login === me) mine += 1;
    }
  }

  const items = [
    { label: 'Total', value: total },
    { label: 'Need review', value: needReview },
    { label: 'Mine', value: mine },
    { label: 'Approved', value: approved },
  ];

  while (el.firstChild) el.firstChild.remove();
  items.forEach((item) => {
    const stat = document.createElement('span');
    stat.className = 'header-stat';
    const label = document.createElement('span');
    label.className = 'header-stat-label';
    label.textContent = `${item.label}: `;
    const value = document.createElement('span');
    value.className = 'header-stat-value';
    value.textContent = String(item.value);
    stat.append(label, value);
    el.appendChild(stat);
    // Brief accent flash when a count actually changes between polls. Skip
    // the very first paint so the initial render isn't a wall of flashes.
    const prev = lastStatsValues.get(item.label);
    if (prev !== undefined && prev !== item.value) {
      value.classList.add('header-stat-value-changed');
      setTimeout(() => value.classList.remove('header-stat-value-changed'), 800);
    }
    lastStatsValues.set(item.label, item.value);
  });
}

const REASON_LABELS = {
  assigned: 'Assigned',
  author: 'Author',
  'review-requested': 'Review Requested',
};

async function showRepoSelectionScreen(onRepoChange) {
  const main = document.getElementById('pr-content');
  while (main.firstChild) main.firstChild.remove();

  setLoading(true, 'Scanning your repositories...');

  let suggestions = [];
  try {
    const data = await api.suggestions();
    suggestions = data.items || [];
  } catch (err) {
    showToast('Failed to scan repos: ' + err.message, 'error');
  } finally {
    setLoading(false);
  }

  while (main.firstChild) main.firstChild.remove();

  // Container
  const container = document.createElement('div');
  container.className = 'repo-selection';

  // Header
  const title = document.createElement('h2');
  title.className = 'repo-selection-title';
  title.textContent = 'Monitor repositories';
  container.appendChild(title);

  const desc = document.createElement('p');
  desc.className = 'repo-selection-desc';
  desc.textContent = 'Select repositories to monitor. These are repos where you have open PRs.';
  container.appendChild(desc);

  // Suggestion list
  if (suggestions.length > 0) {
    const selectAll = document.createElement('label');
    selectAll.className = 'repo-selection-selectall';
    const selectAllCb = document.createElement('input');
    selectAllCb.type = 'checkbox';
    selectAllCb.id = 'select-all';
    selectAll.appendChild(selectAllCb);
    selectAll.appendChild(document.createTextNode(' Select all'));
    container.appendChild(selectAll);

    const list = document.createElement('div');
    list.className = 'repo-selection-list';

    suggestions.forEach((item) => {
      const row = document.createElement('label');
      row.className = 'repo-selection-item';
      if (item.alreadyWatched) row.classList.add('already-watched');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = item.repo;
      cb.checked = !item.alreadyWatched;
      cb.disabled = item.alreadyWatched;
      cb.className = 'repo-cb';
      row.appendChild(cb);

      const info = document.createElement('div');
      info.className = 'repo-selection-info';

      const nameRow = document.createElement('div');
      nameRow.className = 'repo-selection-name';
      nameRow.textContent = item.repo;
      if (item.alreadyWatched) {
        const tag = document.createElement('span');
        tag.className = 'repo-tag repo-tag-watched';
        tag.textContent = 'Watching';
        nameRow.appendChild(tag);
      }
      info.appendChild(nameRow);

      const meta = document.createElement('div');
      meta.className = 'repo-selection-meta';
      meta.textContent = `${item.prCount} open PR(s)`;
      item.reasons.forEach((r) => {
        const tag = document.createElement('span');
        tag.className = 'repo-tag';
        tag.textContent = REASON_LABELS[r] || r;
        meta.appendChild(tag);
      });
      info.appendChild(meta);

      row.appendChild(info);
      list.appendChild(row);
    });

    container.appendChild(list);

    // Select all logic
    selectAllCb.addEventListener('change', () => {
      list.querySelectorAll('.repo-cb:not(:disabled)').forEach((cb) => {
        cb.checked = selectAllCb.checked;
      });
    });
  } else {
    const empty = document.createElement('p');
    empty.className = 'repo-selection-desc';
    empty.textContent = 'No related repositories found. Use the search below to add manually.';
    container.appendChild(empty);
  }

  // Manual search section
  const searchSection = document.createElement('div');
  searchSection.className = 'repo-selection-search';
  const searchLabel = document.createElement('p');
  searchLabel.className = 'repo-selection-desc';
  searchLabel.style.marginTop = '24px';
  searchLabel.textContent = 'Or search for any repository:';
  searchSection.appendChild(searchLabel);

  const searchRow = document.createElement('div');
  searchRow.className = 'repo-selection-search-row';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'owner/repo or keyword...';
  searchInput.className = 'repo-selection-search-input';
  const searchBtn = document.createElement('button');
  searchBtn.className = 'btn-secondary';
  searchBtn.textContent = 'Search';
  searchRow.append(searchInput, searchBtn);
  searchSection.appendChild(searchRow);

  const searchResults = document.createElement('div');
  searchResults.className = 'repo-selection-search-results';
  searchSection.appendChild(searchResults);

  let searchTimeout;
  const doSearch = async () => {
    const q = searchInput.value.trim();
    if (q.length < 2) return;
    try {
      const { items } = await api.searchRepos(q);
      while (searchResults.firstChild) searchResults.firstChild.remove();
      items.forEach((item) => {
        const row = document.createElement('label');
        row.className = 'repo-selection-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = item.fullName;
        cb.className = 'repo-cb manual-cb';
        row.appendChild(cb);
        const info = document.createElement('div');
        info.className = 'repo-selection-info';
        const name = document.createElement('div');
        name.className = 'repo-selection-name';
        name.textContent = item.fullName;
        if (item.private) {
          const tag = document.createElement('span');
          tag.className = 'repo-tag';
          tag.textContent = 'Private';
          name.appendChild(tag);
        }
        info.appendChild(name);
        const descEl = document.createElement('div');
        descEl.className = 'repo-selection-meta';
        descEl.textContent = item.description || '';
        info.appendChild(descEl);
        row.appendChild(info);
        searchResults.appendChild(row);
      });
    } catch (err) {
      showToast('Search failed: ' + err.message, 'error');
    }
  };

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSearch();
    }
  });
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(doSearch, 500);
  });

  container.appendChild(searchSection);

  // Submit button
  const actions = document.createElement('div');
  actions.className = 'repo-selection-actions';
  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn-github';
  submitBtn.style.maxWidth = '320px';
  submitBtn.textContent = 'Add selected & start monitoring';
  submitBtn.addEventListener('click', async () => {
    const checked = container.querySelectorAll('.repo-cb:checked:not(:disabled)');
    const repos = [...checked].map((cb) => cb.value);
    if (repos.length === 0) {
      showToast('Select at least one repository', 'error');
      return;
    }
    setLoading(true, `Adding ${repos.length} repo(s)...`);
    try {
      for (const repo of repos) {
        try {
          await api.addRepo(repo);
        } catch {
          /* skip duplicates */
        }
      }
      showToast(`${repos.length} repo(s) added`);
      await onRepoChange();
      while (main.firstChild) main.firstChild.remove();
      startPolling();
    } finally {
      setLoading(false);
    }
  });
  actions.appendChild(submitBtn);

  // Skip button
  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn-ghost';
  skipBtn.textContent = 'Skip for now';
  skipBtn.addEventListener('click', () => {
    while (main.firstChild) main.firstChild.remove();
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.marginTop = '80px';
    const p = document.createElement('p');
    p.textContent = 'Add repositories from the sidebar to start monitoring PRs';
    empty.appendChild(p);
    main.appendChild(empty);
  });
  actions.appendChild(skipBtn);
  container.appendChild(actions);

  main.appendChild(container);
}

// ============================
// Detail Pane
// ============================
const paneCache = new Map(); // key -> { data, fetchedAt }
const DETAIL_CACHE_TTL = 60_000; // 1 min in-browser cache (server already has 5min cache)

function sweepPaneCache() {
  const cutoff = Date.now() - DETAIL_CACHE_TTL;
  for (const [k, v] of paneCache) {
    if (v.fetchedAt < cutoff) paneCache.delete(k);
  }
}

function openDetailPane(owner, repo, number, title) {
  const pane = document.getElementById('detail-pane');
  const overlay = document.getElementById('detail-overlay');
  const titleEl = document.getElementById('detail-title');
  const content = document.getElementById('detail-content');

  // Stash the active PR's identity on the DOM so the AI-availability flip
  // handler can re-render exactly this pane without reverse-parsing the title
  // (which would mis-fire when two repos share a PR number).
  pane.dataset.owner = owner;
  pane.dataset.repo = repo;
  pane.dataset.number = String(number);
  pane.dataset.title = title;

  // Make the pane an actual dialog for assistive tech.
  pane.setAttribute('role', 'dialog');
  pane.setAttribute('aria-modal', 'true');
  pane.setAttribute('aria-labelledby', 'detail-title');

  titleEl.textContent = `#${number} ${title}`;
  content.textContent = '';

  pane.classList.remove('hidden');
  overlay.classList.remove('hidden');

  // Send focus into the pane on open (close button is the safest target —
  // Esc-aware, no destructive side-effect on accidental Enter).
  requestAnimationFrame(() => {
    document.getElementById('detail-close')?.focus();
  });

  sweepPaneCache();

  const key = `${owner}/${repo}#${number}`;
  const cached = paneCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < DETAIL_CACHE_TTL) {
    renderDetailContent(content, cached.data);
    return;
  }

  // Skeleton: show structural placeholders so the pane has shape immediately
  // instead of just spelling "Loading...". Replaced wholesale once data lands.
  const skeleton = document.createElement('div');
  skeleton.className = 'detail-skeleton';
  skeleton.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i++) {
    const meta = document.createElement('div');
    meta.className = 'skeleton-block skeleton-meta';
    skeleton.appendChild(meta);
  }
  for (let i = 0; i < 5; i++) {
    const row = document.createElement('div');
    row.className = 'skeleton-block skeleton-file';
    skeleton.appendChild(row);
  }
  content.appendChild(skeleton);

  api
    .prDetail(owner, repo, number)
    .then((detail) => {
      paneCache.set(key, { data: detail, fetchedAt: Date.now() });
      // Keep cache size bounded
      if (paneCache.size > 50) {
        const oldestKey = paneCache.keys().next().value;
        paneCache.delete(oldestKey);
      }
      content.textContent = '';
      renderDetailContent(content, detail);
    })
    .catch((err) => {
      content.textContent = '';
      const errEl = document.createElement('div');
      errEl.className = 'detail-loading';
      errEl.textContent = 'Failed to load: ' + err.message;
      content.appendChild(errEl);
    });
}

// Tiny non-crypto hash (FNV-1a 32-bit) for keying caches. Cheap, no async,
// good enough to detect content changes — we only need "did the input
// change?", not collision resistance.
function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function paneContext() {
  const pane = document.getElementById('detail-pane');
  if (!pane) return null;
  const owner = pane.dataset.owner;
  const repo = pane.dataset.repo;
  const number = pane.dataset.number;
  if (!owner || !repo || !number) return null;
  return { owner, repo, number };
}

// Build cache keys that embed a short content hash so the cache auto-misses
// when the underlying PR text changes — preventing "stale 7-day-old summary"
// situations after a PR is updated.
function prCacheKey(ctx, detail) {
  if (!ctx) return null;
  const filenames = (detail?.files || []).map((f) => f.filename).join('|');
  const sig = shortHash(`${detail?.title || ''}|${detail?.body || ''}|${filenames}`);
  return `pr:${ctx.owner}/${ctx.repo}#${ctx.number}@${sig}`;
}

function threadCacheKey(ctx, thread) {
  if (!ctx) return null;
  const text = (thread?.comments || [])
    .map((c) => `${c.author?.login || ''}:${c.body || ''}`)
    .join('\n');
  const sig = shortHash(text);
  return `thread:${ctx.owner}/${ctx.repo}#${ctx.number}:${thread.path}:${thread.line ?? 0}@${sig}`;
}

function checkCacheKey(ctx, check, input) {
  if (!ctx) return null;
  const sig = shortHash(`${check.name}|${input}`);
  return `check:${ctx.owner}/${ctx.repo}#${ctx.number}:${check.name}@${sig}`;
}

function relativeAge(at) {
  const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (sec < 60) return 'たった今';
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
  return `${Math.floor(sec / 86400)}日前`;
}

function renderSummaryInto(host, kind, { summary, cli, at }) {
  const existing = host.querySelector('.detail-ai-summary');
  if (existing) existing.remove();
  const summaryEl = document.createElement('div');
  summaryEl.className = 'detail-ai-summary';

  const label = document.createElement('div');
  label.className = 'detail-ai-summary-label';
  const main = document.createElement('span');
  const kindLabel = kind === 'pr' ? 'PR Summary' : kind === 'check' ? 'Check Analysis' : 'Summary';
  main.textContent = `${kindLabel} (${cli || 'AI'})`;
  label.appendChild(main);
  if (at) {
    const cacheTag = document.createElement('span');
    cacheTag.className = 'detail-ai-summary-cache';
    cacheTag.textContent = ` · ${relativeAge(at)} のキャッシュ`;
    cacheTag.title = 'ローカル保存の要約。最新内容は「再要約」で取得できます';
    label.appendChild(cacheTag);
  }
  summaryEl.appendChild(label);

  const body = document.createElement('div');
  body.className = 'detail-ai-summary-body';
  body.textContent = summary;
  summaryEl.appendChild(body);

  // Indirect prompt-injection mitigation: PR titles/bodies/filenames are
  // user-controlled GitHub content, so the LLM output may contain hallucinated
  // claims. Surface this caveat under every summary so reviewers don't treat
  // the summary as authoritative.
  const disclaimer = document.createElement('div');
  disclaimer.className = 'detail-ai-summary-disclaimer';
  disclaimer.textContent = 'LLM による要約です。重要な判断の前に必ず原文を確認してください。';
  summaryEl.appendChild(disclaimer);

  host.appendChild(summaryEl);
}

// Thread comments → AI summary. Background-task: caller can close the
// pane and the request still completes (header indicator + native
// notification announce it). On reopen, the cached summary surfaces and
// the button reads "再要約".
function runSummarize(card, btn, text, cacheKey) {
  if (!cacheKey) return;
  const ctx = paneContext();
  const label = ctx ? `${ctx.owner}/${ctx.repo}#${ctx.number} thread summary` : 'thread summary';

  const existing = card.querySelector('.detail-ai-summary');
  if (existing) existing.remove();
  const summaryEl = document.createElement('div');
  summaryEl.className = 'detail-ai-summary loading';
  summaryEl.textContent = 'AI で要約中...';
  card.appendChild(summaryEl);
  btn.disabled = true;
  btn.textContent = '要約中...';

  startAiAnalysis({
    key: cacheKey,
    label,
    run: () => api.aiSummarize(text),
    onComplete: ({ summary, cli }) => {
      if (document.contains(card)) {
        summaryEl.remove();
        renderSummaryInto(card, 'thread', { summary, cli, at: null });
        btn.textContent = '再要約';
        btn.disabled = false;
      }
    },
    onError: (err) => {
      if (document.contains(summaryEl)) {
        summaryEl.classList.remove('loading');
        summaryEl.classList.add('error');
        summaryEl.textContent = err.message;
        btn.textContent = 'AIで要約';
        btn.disabled = false;
      }
    },
  });
}

// PR-as-a-whole → AI summary. Same background-task pattern as
// runSummarize, but hits the PR-specific endpoint that adds file list
// context to the prompt.
function runPRSummarize(host, btn, detail) {
  const ctx = paneContext();
  const cacheKey = prCacheKey(ctx, detail);
  if (!cacheKey) return;
  const label = `${ctx.owner}/${ctx.repo}#${ctx.number} PR summary`;
  const originalLabel = btn.textContent;

  const existing = host.querySelector('.detail-ai-summary');
  if (existing) existing.remove();
  const summaryEl = document.createElement('div');
  summaryEl.className = 'detail-ai-summary loading';
  summaryEl.textContent = 'AI で PR を要約中...';
  host.appendChild(summaryEl);
  btn.disabled = true;
  btn.textContent = '要約中...';

  const files = (detail.files || []).map((f) => ({
    filename: f.filename,
    additions: f.additions || 0,
    deletions: f.deletions || 0,
  }));

  startAiAnalysis({
    key: cacheKey,
    label,
    run: () =>
      api.aiSummarizePR({
        title: detail.title || '',
        body: detail.body || '',
        files,
      }),
    onComplete: ({ summary, cli }) => {
      if (document.contains(host)) {
        summaryEl.remove();
        renderSummaryInto(host, 'pr', { summary, cli, at: null });
        btn.textContent = '再要約';
        btn.disabled = false;
      }
    },
    onError: () => {
      if (document.contains(summaryEl)) {
        summaryEl.remove();
        btn.textContent = originalLabel;
        btn.disabled = false;
      }
    },
  });
}

function closeDetailPane() {
  document.getElementById('detail-pane').classList.add('hidden');
  document.getElementById('detail-overlay').classList.add('hidden');
  // Drop TTL-expired entries on close so an idle SPA doesn't accumulate
  // 50 stale (but TTL-fresh-when-cached) detail blobs in memory.
  sweepPaneCache();
  // Restore focus to whatever opened the pane (improves keyboard nav).
  if (lastDetailTrigger && document.contains(lastDetailTrigger)) {
    lastDetailTrigger.focus();
    lastDetailTrigger = null;
  }
}

// Map raw GitHub conclusion / state strings to a short, human-readable label
// so the badge text on each failed check is not just "TIMED_OUT" caps.
const FAILED_CHECK_LABELS = {
  FAILURE: 'Failure',
  TIMED_OUT: 'Timed out',
  CANCELLED: 'Cancelled',
  ACTION_REQUIRED: 'Action required',
  STARTUP_FAILURE: 'Startup failure',
  ERROR: 'Error',
};

function renderFailedChecks(container, detail) {
  const failed = Array.isArray(detail.failedChecks) ? detail.failedChecks : [];
  const error = detail.failedChecksError;
  if (!error && failed.length === 0) return;

  const title = document.createElement('div');
  title.className = 'detail-section-title';
  title.textContent = error ? 'Failed checks: 取得失敗' : `Failed checks (${failed.length})`;
  if (error) title.style.color = 'var(--status-pending-text)';
  container.appendChild(title);

  if (error) {
    const errEl = document.createElement('div');
    errEl.className = 'detail-checks-error';
    errEl.textContent = error;
    container.appendChild(errEl);
    return;
  }

  const list = document.createElement('div');
  list.className = 'detail-check-list';

  failed.forEach((c) => {
    list.appendChild(renderFailedCheckEntry(c));
  });

  container.appendChild(list);
}

// Pick the most useful "why did this fail?" payload from a check, in
// priority order: annotations (file:line precision) → summary (CheckRun
// markdown) → description (StatusContext blurb). Returns null when none
// of those are present so callers can collapse the row to "just a link".
function pickCheckDetail(c) {
  if (c.annotations && c.annotations.length > 0) {
    return { kind: 'annotations', annotations: c.annotations };
  }
  const summary = c.summary && c.summary.trim();
  if (summary) return { kind: 'summary', text: summary };
  const description = c.description && c.description.trim();
  if (description) return { kind: 'description', text: description };
  return null;
}

// One failed check row + on-demand expand. detail (annotations / summary /
// description) drives whether the row is a button (expandable) or a plain
// link to the run page.
function renderFailedCheckEntry(c) {
  const wrapper = document.createElement('div');
  wrapper.className = 'detail-check-entry';

  const detail = pickCheckDetail(c);
  const hasDetail = detail !== null;

  // Header row: clickable to expand when there's detail to show, plain
  // link to the Actions/CI page when there isn't.
  const head = document.createElement(hasDetail ? 'button' : c.url ? 'a' : 'div');
  head.className = 'detail-check';
  if (hasDetail) {
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
  } else if (c.url) {
    head.href = c.url;
    head.target = '_blank';
    head.rel = 'noopener';
  }

  if (hasDetail) {
    const caret = document.createElement('span');
    caret.className = 'detail-check-caret';
    caret.textContent = '▸';
    head.appendChild(caret);
  }

  const badge = document.createElement('span');
  badge.className = 'detail-check-badge';
  badge.textContent = FAILED_CHECK_LABELS[c.conclusion] || c.conclusion || 'Failed';
  head.appendChild(badge);

  const name = document.createElement('span');
  name.className = 'detail-check-name';
  name.textContent = c.name;
  name.title = c.name;
  head.appendChild(name);

  // For StatusContext (no annotations), the inline description doubles as
  // the only signal — keep it visible on the row even when collapsed.
  if (c.description && !c.annotations) {
    const desc = document.createElement('span');
    desc.className = 'detail-check-desc';
    desc.textContent = c.description;
    desc.title = c.description;
    head.appendChild(desc);
  }

  if (c.completedAt) {
    const time = document.createElement('span');
    time.className = 'detail-check-time';
    time.textContent = relativeTime(c.completedAt);
    head.appendChild(time);
  }

  wrapper.appendChild(head);

  if (!hasDetail) return wrapper;

  let body = null;
  head.addEventListener('click', () => {
    const open = head.getAttribute('aria-expanded') === 'true';
    if (open) {
      head.setAttribute('aria-expanded', 'false');
      head.querySelector('.detail-check-caret').textContent = '▸';
      if (body) body.style.display = 'none';
      return;
    }
    head.setAttribute('aria-expanded', 'true');
    head.querySelector('.detail-check-caret').textContent = '▾';
    if (!body) {
      body = renderCheckBody(c, detail);
      wrapper.appendChild(body);
    } else {
      body.style.display = '';
    }
  });

  return wrapper;
}

function renderCheckBody(c, detail) {
  const body = document.createElement('div');
  body.className = 'detail-check-body';

  if (detail?.kind === 'annotations') {
    const list = document.createElement('div');
    list.className = 'detail-check-annotations';
    for (const a of detail.annotations) {
      const row = document.createElement('div');
      row.className = `detail-check-annotation ${a.level === 'WARNING' ? 'warn' : 'fail'}`;
      const loc = document.createElement('span');
      loc.className = 'detail-check-annotation-loc';
      loc.textContent = a.path ? (a.startLine ? `${a.path}:${a.startLine}` : a.path) : '(no path)';
      row.appendChild(loc);
      if (a.title) {
        const t = document.createElement('div');
        t.className = 'detail-check-annotation-title';
        t.textContent = a.title;
        row.appendChild(t);
      }
      const msg = document.createElement('div');
      msg.className = 'detail-check-annotation-msg';
      msg.textContent = a.message || '';
      row.appendChild(msg);
      list.appendChild(row);
    }
    body.appendChild(list);
  } else if (detail?.kind === 'summary' || detail?.kind === 'description') {
    const sum = document.createElement('pre');
    sum.className = 'detail-check-summary';
    sum.textContent = detail.text;
    body.appendChild(sum);
  }

  // Open-in-GitHub for the underlying run/log
  if (c.url) {
    const link = document.createElement('a');
    link.className = 'detail-check-body-link';
    link.href = c.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'GitHub で開く';
    body.appendChild(link);
  }

  // AI analysis button — only when AI server is up AND there's something to
  // feed it. Prompt is composed locally so it's well-scoped: "this is a
  // failed CI check, here's what GitHub reported".
  const analysisInput = composeCheckAnalysisInput(c, detail);
  const ctx = paneContext();
  const cacheKey = checkCacheKey(ctx, c, analysisInput || '');
  if (isAiAvailable() && analysisInput && cacheKey) {
    const aiBtn = document.createElement('button');
    aiBtn.className = 'detail-check-ai-btn';
    aiBtn.type = 'button';
    aiBtn.textContent = 'AI で原因分析';

    const label = `${ctx.owner}/${ctx.repo}#${ctx.number} ${c.name}`;

    if (aiTasksInProgress.has(cacheKey)) {
      aiBtn.textContent = '分析中…';
      aiBtn.disabled = true;
    }

    aiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      aiBtn.textContent = '分析中…';
      aiBtn.disabled = true;
      startAiAnalysis({
        key: cacheKey,
        label,
        run: () => api.aiSummarize(analysisInput),
        onComplete: ({ summary, cli }) => {
          if (document.contains(body)) {
            renderSummaryInto(body, 'check', { summary, cli, at: null });
            aiBtn.textContent = '再要約';
            aiBtn.disabled = false;
          }
        },
        onError: () => {
          if (document.contains(aiBtn)) {
            aiBtn.textContent = 'AI で原因分析';
            aiBtn.disabled = false;
          }
        },
      });
    });
    body.appendChild(aiBtn);

    const cached = readAiSummary(cacheKey);
    if (cached) {
      renderSummaryInto(body, 'check', cached);
      aiBtn.textContent = '再要約';
    }
  }

  return body;
}

function composeCheckAnalysisInput(c, detail) {
  if (!detail) return null;
  const parts = [`Failed CI check: ${c.name}`, `Conclusion: ${c.conclusion}`];
  if (detail.kind === 'annotations') {
    parts.push('\nAnnotations:');
    for (const a of detail.annotations) {
      const loc = a.path ? (a.startLine ? `${a.path}:${a.startLine}` : a.path) : '(no path)';
      parts.push(`- [${a.level || 'FAILURE'}] ${loc}`);
      if (a.title) parts.push(`  title: ${a.title}`);
      if (a.message) parts.push(`  message: ${a.message}`);
    }
  } else {
    parts.push(`\n${detail.kind === 'summary' ? 'Summary' : 'Description'}:`);
    parts.push(detail.text);
  }
  return parts.join('\n');
}

// Background AI analysis tasks live here so they survive the detail pane
// being closed. Key is the localStorage cache key, so a repeated click on
// the same check coalesces into one in-flight request.
const aiTasksInProgress = new Map(); // key -> { label, startedAt }

function updateAiTaskIndicator() {
  const el = document.getElementById('ai-tasks-indicator');
  if (!el) return;
  const count = aiTasksInProgress.size;
  if (count === 0) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.title = [...aiTasksInProgress.values()].map((t) => t.label).join(' / ');
  const countEl = el.querySelector('.ai-tasks-count');
  if (countEl) countEl.textContent = String(count);
}

// Fire-and-forget AI request. Pane can close, navigation can change —
// the request still resolves: result lands in localStorage cache, header
// indicator decrements, native notification + toast announce completion.
// Repeated clicks while one is in-flight are deduped via the cache key.
//
// `run` returns a Promise<{ summary, cli }>; callers swap in
// api.aiSummarize / api.aiSummarizePR / future endpoints without this
// helper needing to know which.
function startAiAnalysis({ key, label, run, onComplete, onError }) {
  if (!key || typeof run !== 'function') return;
  if (aiTasksInProgress.has(key)) {
    showToast(`既に分析中: ${label}`, 'info');
    return;
  }
  aiTasksInProgress.set(key, { label, startedAt: Date.now() });
  updateAiTaskIndicator();

  Promise.resolve()
    .then(() => run())
    .then(({ summary, cli }) => {
      writeAiSummary(key, summary, cli);
      sendNotification('AI 要約完了', label);
      showToast(`AI 要約完了: ${label}`, 'success');
      if (typeof onComplete === 'function') onComplete({ summary, cli });
    })
    .catch((err) => {
      showToast(`AI 要約失敗 (${label}): ${err.message}`, 'error');
      if (typeof onError === 'function') onError(err);
    })
    .finally(() => {
      aiTasksInProgress.delete(key);
      updateAiTaskIndicator();
    });
}

// Hard cap on rendered diff lines per file. A handful of files in real PRs
// contain thousands of lines (lockfiles, generated bundles); rendering them
// all freezes the pane and bloats the DOM. Anything above this is truncated
// with a note + a link to the full diff on GitHub.
const MAX_DIFF_LINES = 500;

// Parse a unified diff hunk header `@@ -<oldStart>,<oldLen> +<newStart>,<newLen> @@`
// and return the starting old/new line numbers. Length fields are optional in
// single-line hunks (`@@ -3 +3 @@`).
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Map filename → highlight.js language id. Bundled cdn-assets common build
// covers all of these. Extensions not listed here render with no highlight
// (still readable thanks to the +/- gutter coloring).
const HLJS_BY_EXT = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  dart: 'dart',
  dockerfile: 'dockerfile',
  vue: 'xml',
  svelte: 'xml',
};
const HLJS_BY_BASENAME = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  '.gitignore': 'plaintext',
};

function detectHljsLang(filename) {
  if (!filename) return null;
  const base = filename.split('/').pop();
  if (HLJS_BY_BASENAME[base]) return HLJS_BY_BASENAME[base];
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx === -1) return null;
  return HLJS_BY_EXT[base.slice(dotIdx + 1).toLowerCase()] || null;
}

function highlightLine(body, lang) {
  // Skip when hljs isn't loaded (CSP blocked it / lib missing) or the
  // language isn't bundled. Fall back to plain text — caller renders via
  // textContent in that case.
  const hljs = window.hljs;
  if (!hljs || !lang || !hljs.getLanguage(lang)) return null;
  try {
    return hljs.highlight(body, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

// Lazy-load language modules from jsdelivr that aren't part of the bundled
// common build (Dart, Dockerfile, Elixir, Zig, Terraform, ...). Pinned to
// the same version we ship locally so the upstream API can't drift.
const HLJS_VERSION = '11.11.1';
const langLoadPromises = new Map();
function isLangLoaded(lang) {
  return !!window.hljs?.getLanguage(lang);
}
function loadLang(lang) {
  if (!lang) return Promise.resolve(false);
  if (isLangLoaded(lang)) return Promise.resolve(true);
  if (langLoadPromises.has(lang)) return langLoadPromises.get(lang);
  const url = `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@${HLJS_VERSION}/languages/${lang}.min.js`;
  const p = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => resolve(isLangLoaded(lang));
    // Drop the rejected promise so a later expand can retry. Without
    // this delete the user has to reload the page after a transient
    // network blip.
    script.onerror = () => {
      langLoadPromises.delete(lang);
      resolve(false);
    };
    document.head.appendChild(script);
  });
  langLoadPromises.set(lang, p);
  return p;
}

function renderFileDiff(file) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-file-diff';

  if (file.patch == null) {
    // GitHub omits patch for binary files (images, fonts) and very large
    // entries. Surface the reason rather than an empty box.
    const note = document.createElement('div');
    note.className = 'detail-file-diff-note';
    note.textContent = 'バイナリファイル、または GitHub が diff を返さなかったファイルです';
    wrap.appendChild(note);
    return wrap;
  }

  const lines = file.patch.split('\n');
  const truncated = lines.length > MAX_DIFF_LINES;
  const visible = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;
  const lang = detectHljsLang(file.filename);

  // Two columns of line numbers + the source line, laid out in a single CSS
  // grid (one row per diff line). Children are appended directly to the
  // grid container — wrapping each row in a div with `display: contents`
  // is still buggy for grid in Safari 16.
  const grid = document.createElement('div');
  grid.className = 'detail-file-diff-grid';

  let oldLine = 0;
  let newLine = 0;

  for (const raw of visible) {
    if (raw.startsWith('@@')) {
      const m = raw.match(HUNK_RE);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      const hunk = document.createElement('div');
      hunk.className = 'diff-hunk';
      hunk.textContent = raw;
      grid.appendChild(hunk);
      continue;
    }

    let cls = 'diff-context';
    let oldNum = '';
    let newNum = '';

    let prefix = '';
    let body = raw;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      cls = 'diff-add';
      prefix = '+';
      body = raw.slice(1);
      newNum = String(newLine);
      newLine += 1;
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      cls = 'diff-del';
      prefix = '-';
      body = raw.slice(1);
      oldNum = String(oldLine);
      oldLine += 1;
    } else if (raw.startsWith('---') || raw.startsWith('+++')) {
      // GitHub usually strips the `--- a/...` / `+++ b/...` headers, but
      // be defensive in case a future API revision starts including them.
      cls = 'diff-meta';
    } else {
      // Unified diff context lines start with a single space — drop it so
      // body holds the actual source line as it appears in the file.
      body = raw.startsWith(' ') ? raw.slice(1) : raw;
      oldNum = String(oldLine);
      newNum = String(newLine);
      oldLine += 1;
      newLine += 1;
    }

    const oldEl = document.createElement('span');
    oldEl.className = `diff-num ${cls}`;
    oldEl.textContent = oldNum;

    const newEl = document.createElement('span');
    newEl.className = `diff-num ${cls}`;
    newEl.textContent = newNum;

    const codeEl = document.createElement('span');
    codeEl.className = `diff-code ${cls}`;
    // Render the +/- prefix via a CSS ::before with the data-prefix attr so
    // it's excluded from text selection and copy.
    codeEl.dataset.prefix = prefix;
    const safeBody = body === '' ? ' ' : body;
    const highlighted = cls === 'diff-meta' ? null : highlightLine(safeBody, lang);
    if (highlighted) {
      codeEl.innerHTML = highlighted;
    } else {
      codeEl.textContent = safeBody;
    }

    grid.append(oldEl, newEl, codeEl);
  }
  wrap.appendChild(grid);

  if (truncated) {
    const note = document.createElement('div');
    note.className = 'detail-file-diff-note';
    note.textContent = `${MAX_DIFF_LINES} 行で打ち切り (全 ${lines.length} 行)。続きは GitHub で確認してください。`;
    wrap.appendChild(note);
  }
  return wrap;
}

function renderDetailContent(container, detail) {
  // Action row: Open in GitHub + PR summary button
  const actionRow = document.createElement('div');
  actionRow.className = 'detail-action-row';

  const openBtn = document.createElement('a');
  openBtn.className = 'detail-open-btn';
  openBtn.href = detail.url;
  openBtn.target = '_blank';
  openBtn.rel = 'noopener';
  openBtn.textContent = 'Open in GitHub';
  actionRow.appendChild(openBtn);

  // AI summary button is opt-in: render only when ai-server is reachable
  // and a usable CLI is configured. Without this, clicking the button when
  // ai-server is down would just show a 503 toast.
  let summarizePrBtn = null;
  const prSummaryHost = document.createElement('div');
  prSummaryHost.className = 'detail-pr-summary-host';

  // Pre-populate from cache so the user sees their previous AI summary
  // immediately on reopen, without re-spending CLI time. Button label flips
  // to "再要約" so it's obvious this is regeneration vs first-time.
  const ctx = paneContext();
  const prKey = prCacheKey(ctx, detail);
  const cachedPrSummary = prKey ? readAiSummary(prKey) : null;
  if (cachedPrSummary) {
    renderSummaryInto(prSummaryHost, 'pr', cachedPrSummary);
  }

  if (isAiAvailable()) {
    summarizePrBtn = document.createElement('button');
    summarizePrBtn.className = 'detail-pr-summary-btn';
    summarizePrBtn.textContent = cachedPrSummary ? '再要約' : 'PR全体をAIで要約';
    actionRow.appendChild(summarizePrBtn);
  }

  container.appendChild(actionRow);
  container.appendChild(prSummaryHost);

  if (summarizePrBtn) {
    summarizePrBtn.addEventListener('click', async () => {
      await runPRSummarize(prSummaryHost, summarizePrBtn, detail);
    });
  }

  // Meta stats
  const metaTitle = document.createElement('div');
  metaTitle.className = 'detail-section-title';
  metaTitle.textContent = 'Changes';
  container.appendChild(metaTitle);

  const meta = document.createElement('div');
  meta.className = 'detail-meta';

  let mergeValue, mergeCls;
  if (detail.mergeable === false) {
    mergeValue = 'Conflicts';
    mergeCls = 'deletions';
  } else if (detail.mergeable === true) {
    mergeValue = 'Mergeable';
    mergeCls = 'additions';
  } else {
    mergeValue = 'Checking...';
    mergeCls = '';
  }

  const behindValue = typeof detail.behindBy === 'number' ? `↓ ${detail.behindBy}` : '—';
  const aheadValue = typeof detail.aheadBy === 'number' ? `↑ ${detail.aheadBy}` : '—';

  const items = [
    { label: 'Files', value: detail.changedFiles, cls: '' },
    { label: 'Branch', value: `${detail.branch} → ${detail.baseBranch}`, cls: '' },
    { label: 'Additions', value: `+${detail.additions}`, cls: 'additions' },
    { label: 'Deletions', value: `-${detail.deletions}`, cls: 'deletions' },
    { label: 'Merge', value: mergeValue, cls: mergeCls },
    {
      label: `vs ${detail.baseBranch}`,
      value: `${behindValue} / ${aheadValue}`,
      cls: detail.behindBy >= 10 ? 'deletions' : '',
    },
  ];

  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'detail-meta-item';
    const label = document.createElement('div');
    label.className = 'detail-meta-label';
    label.textContent = item.label;
    const value = document.createElement('div');
    value.className = `detail-meta-value ${item.cls}`;
    value.textContent = item.value;
    el.append(label, value);
    meta.appendChild(el);
  });
  container.appendChild(meta);

  // Failed CI checks: only render the section when there's something to act
  // on (failed run, fetch error, or — when explicitly red — a "no failing
  // contexts to enumerate" hint). Successful/pending rollups stay hidden so
  // the pane isn't dominated by green ticks.
  renderFailedChecks(container, detail);

  // Files (clickable to expand the unified diff inline)
  if (detail.files.length > 0) {
    const filesTitle = document.createElement('div');
    filesTitle.className = 'detail-section-title';
    filesTitle.textContent = `Files (${detail.files.length})`;
    container.appendChild(filesTitle);

    const fileList = document.createElement('div');
    fileList.className = 'detail-file-list';

    detail.files.forEach((f) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'detail-file-entry';

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'detail-file';
      row.setAttribute('aria-expanded', 'false');

      const caret = document.createElement('span');
      caret.className = 'detail-file-caret';
      caret.textContent = '▸';
      row.appendChild(caret);

      const badge = document.createElement('span');
      badge.className = `detail-file-badge ${f.status}`;
      badge.textContent = f.status.charAt(0).toUpperCase();
      row.appendChild(badge);

      const name = document.createElement('span');
      name.className = 'detail-file-name';
      name.textContent = f.filename;
      name.title = f.filename;
      row.appendChild(name);

      if (f.additions > 0) {
        const add = document.createElement('span');
        add.className = 'detail-file-stat add';
        add.textContent = `+${f.additions}`;
        row.appendChild(add);
      }
      if (f.deletions > 0) {
        const del = document.createElement('span');
        del.className = 'detail-file-stat del';
        del.textContent = `-${f.deletions}`;
        row.appendChild(del);
      }

      wrapper.appendChild(row);

      // Diff body — created lazily on first expand to avoid building DOM
      // for files the user never opens (a 100-file PR would otherwise
      // build 100 patch DOM trees up front).
      let diffEl = null;
      const toggle = async () => {
        const isOpen = row.getAttribute('aria-expanded') === 'true';
        if (isOpen) {
          row.setAttribute('aria-expanded', 'false');
          caret.textContent = '▸';
          if (diffEl) diffEl.style.display = 'none';
          return;
        }
        row.setAttribute('aria-expanded', 'true');
        caret.textContent = '▾';
        if (!diffEl) {
          // Resolve the highlight.js language for this filename and lazy
          // load it from jsdelivr if it's not already in the bundled set.
          // Render proceeds even if the load fails — diff just falls back
          // to plain text.
          const lang = detectHljsLang(f.filename);
          if (lang && !isLangLoaded(lang)) {
            await loadLang(lang);
          }
          diffEl = renderFileDiff(f);
          wrapper.appendChild(diffEl);
        } else {
          diffEl.style.display = '';
        }
      };
      row.addEventListener('click', toggle);

      fileList.appendChild(wrapper);
    });
    container.appendChild(fileList);
  }

  // Unresolved review threads
  if (detail.unresolvedThreadsError) {
    const errBlock = document.createElement('div');
    errBlock.className = 'detail-section-title';
    errBlock.textContent = `Unresolved comments: 取得失敗 (${detail.unresolvedThreadsError})`;
    errBlock.style.color = 'var(--status-pending-text)';
    container.appendChild(errBlock);
  } else if (detail.unresolvedThreads && detail.unresolvedThreads.length > 0) {
    const unresolvedTitle = document.createElement('div');
    unresolvedTitle.className = 'detail-section-title';
    unresolvedTitle.textContent = `Unresolved comments (${detail.unresolvedThreads.length})`;
    container.appendChild(unresolvedTitle);

    detail.unresolvedThreads.forEach((thread) => {
      const card = document.createElement('div');
      card.className = 'detail-thread';

      // Header: location + AI summarize button
      const headerRow = document.createElement('div');
      headerRow.className = 'detail-thread-header';

      const loc = document.createElement('div');
      loc.className = 'detail-thread-location';
      const path = document.createElement('span');
      path.className = 'mono';
      path.textContent = thread.path;
      loc.appendChild(path);
      if (thread.line) {
        const line = document.createElement('span');
        line.className = 'mono detail-thread-line';
        line.textContent = `:${thread.line}`;
        loc.appendChild(line);
      }
      headerRow.appendChild(loc);

      const cacheKey = ctx ? threadCacheKey(ctx, thread) : null;
      const cachedThreadSummary = cacheKey ? readAiSummary(cacheKey) : null;

      if (isAiAvailable()) {
        const aiBtn = document.createElement('button');
        aiBtn.className = 'detail-ai-btn';
        aiBtn.textContent = cachedThreadSummary ? '再要約' : 'AIで要約';
        aiBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const allText = thread.comments
            .map((c) => `${c.author?.login || 'unknown'}: ${c.body}`)
            .join('\n\n');
          await runSummarize(card, aiBtn, allText, cacheKey);
        });
        headerRow.appendChild(aiBtn);
      }

      card.appendChild(headerRow);

      // Comments
      thread.comments.forEach((c) => {
        const comment = document.createElement('a');
        comment.className = 'detail-thread-comment';
        comment.href = c.url;
        comment.target = '_blank';
        comment.rel = 'noopener';

        const header = document.createElement('div');
        header.className = 'detail-thread-comment-header';
        if (c.author) {
          const avatar = createAvatar(c.author.avatarUrl);
          header.appendChild(avatar);
          const login = document.createElement('span');
          login.textContent = c.author.login;
          login.style.fontWeight = '600';
          header.appendChild(login);
        }
        comment.appendChild(header);

        const body = document.createElement('div');
        body.className = 'detail-thread-comment-body';
        body.textContent = c.body;
        comment.appendChild(body);

        card.appendChild(comment);
      });

      if (cachedThreadSummary) {
        renderSummaryInto(card, 'thread', cachedThreadSummary);
      }

      container.appendChild(card);
    });
  }
}

function showBanner(message, type) {
  let banner = document.getElementById('banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'banner';
    const main = document.getElementById('pr-content');
    main.parentNode.insertBefore(banner, main);
  }
  banner.className = `banner banner-${type}`;
  banner.textContent = message;
}

function hideBanner() {
  const banner = document.getElementById('banner');
  if (banner) banner.remove();
}

let pollingCallId = 0;

// Polling cadence when the tab is in the background. Long enough to keep
// rate-limit consumption negligible (12 req/h per repo), short enough that
// `detectChangesAndNotify` can still fire native browser notifications for
// PRs that arrive while the user is on another tab.
const BACKGROUND_POLL_MS = 5 * 60 * 1000;

async function startPolling({ skipImmediate = false, intervalMs = null } = {}) {
  stopPolling();
  // Tag this invocation; if a newer startPolling races us across the
  // `await api.settings()` (e.g. visibilitychange + loadSingleRepo finally),
  // the older call must drop its setInterval to avoid leaking a duplicate.
  const callId = ++pollingCallId;
  try {
    let interval;
    if (intervalMs != null) {
      interval = intervalMs; // background mode bypasses the user's setting
    } else {
      const settings = await api.settings();
      if (callId !== pollingCallId) return;
      interval = settings.pollInterval * 1000;
    }
    if (!skipImmediate) await loadPRs();
    if (callId !== pollingCallId) return;
    pollTimer = setInterval(loadPRs, interval);
  } catch {
    if (callId !== pollingCallId) return;
    if (!skipImmediate) await loadPRs();
    if (callId !== pollingCallId) return;
    pollTimer = setInterval(loadPRs, intervalMs ?? 60_000);
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Page Visibility API. The "last updated" UI timer stops when the tab is
// hidden (no point spending CPU updating an invisible label), but the data
// poller switches to a slow background cadence instead of fully stopping —
// otherwise PRs that arrive while the user is on another tab go undetected
// and detectChangesAndNotify can never fire a native browser notification.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopLastUpdatedTimer();
    startPolling({ skipImmediate: true, intervalMs: BACKGROUND_POLL_MS });
  } else {
    startLastUpdatedTimer();
    updateLastUpdatedDisplay();
    // Re-check ai-server availability so a freshly-started ai-server is
    // picked up without a full page reload. Throttled to avoid spamming
    // /api/ai/status when the user rapidly cycles through tabs.
    maybeRefreshAi();
    // Throttle: if we fetched very recently, only restart the timer without an immediate fetch.
    const elapsed = Date.now() - lastFetchAt;
    const skipImmediate = lastFetchAt > 0 && elapsed < VISIBILITY_REFETCH_THRESHOLD;
    startPolling({ skipImmediate });
  }
});

const AI_REFRESH_COOLDOWN_MS = 30_000;
let lastAiRefreshAt = 0;

function maybeRefreshAi() {
  if (Date.now() - lastAiRefreshAt < AI_REFRESH_COOLDOWN_MS) return;
  lastAiRefreshAt = Date.now();
  refreshAiPanel();
}

// When AI availability flips, adjust the open detail pane in-place. We avoid
// re-fetching the PR detail (which would discard a freshly-generated AI
// summary the user is reading) and only touch the AI buttons:
//   - false: remove the AI action buttons (the requests would only 503)
//   - true:  re-render via openDetailPane so the buttons reappear; the cached
//            detail (if still warm in paneCache) is reused, no API call
onAiAvailabilityChange((available) => {
  const pane = document.getElementById('detail-pane');
  if (!pane || pane.classList.contains('hidden')) return;
  if (!available) {
    pane.querySelectorAll('.detail-pr-summary-btn, .detail-ai-btn').forEach((b) => b.remove());
    return;
  }
  const owner = pane.dataset.owner;
  const repo = pane.dataset.repo;
  const number = Number(pane.dataset.number);
  const title = pane.dataset.title;
  if (!owner || !repo || !Number.isFinite(number)) return;
  openDetailPane(owner, repo, number, title || '');
});

function applyUserToHeader(user) {
  if (!user) return;
  window.__ME__ = user.login;
  const userNameEl = document.getElementById('user-name');
  const userAvatarEl = document.getElementById('user-avatar');
  if (userNameEl) userNameEl.textContent = user.login;
  if (userAvatarEl && user.avatarUrl) userAvatarEl.src = user.avatarUrl;
}

function paintFromCache() {
  // Best-effort instant repaint after a hard reload. We render whatever
  // cached state we have (header user + dashboard PRs) so the screen isn't
  // blank while the fresh API calls are in flight. Sidebar gets re-painted
  // by the standard renderRepoList() flow shortly after.
  const cachedMe = readCache(CACHE_KEYS.me);
  if (cachedMe?.data) applyUserToHeader(cachedMe.data);

  const cachedPrs = readCache(CACHE_KEYS.prs);
  if (cachedPrs?.data?.repos) {
    lastData = cachedPrs.data;
    lastFetchAt = cachedPrs.at;
    updateStats(cachedPrs.data);
    const main = document.getElementById('pr-content');
    if (main) {
      reconcileRepoSections(main, cachedPrs.data.repos);
      lastRenderSig = renderSignature(cachedPrs.data);
    }
    updateLastUpdatedDisplay();
  }
}

// Init
async function init() {
  cleanupLegacyStorage();

  requestNotificationPermission();

  // Token lives only in localStorage. No backend session.
  if (!getStoredToken()) {
    window.location.href = '/setup.html';
    return;
  }

  // Repaint from localStorage BEFORE any network call so a hard reload shows
  // the previous dashboard immediately. The fresh fetch below replaces it.
  paintFromCache();

  let me;
  try {
    const { user } = await api.authMe();
    me = user;
    writeCache(CACHE_KEYS.me, user);
  } catch (err) {
    // Only force re-login when GitHub itself rejected the PAT. Transient
    // failures (network blip, backend 5xx, the SW-takeover race that drops
    // a header) shouldn't wipe credentials and bounce the user out — they
    // would all flush the user to setup.html and lose the stored PAT.
    if (err.code === 'GITHUB_TOKEN_EXPIRED') {
      clearStoredToken();
      window.location.href = '/setup.html';
      return;
    }
    // Otherwise: try to bootstrap from cached identity so the page still
    // loads and polling can recover on the next tick.
    const cached = readCache(CACHE_KEYS.me);
    if (cached?.data) {
      me = cached.data;
      showToast('GitHub への接続に失敗しました。キャッシュ表示中', 'error');
    } else {
      // No cached identity to fall back to — surface the error and stop.
      // We don't redirect to setup.html because the PAT is still valid as
      // far as we know, and forcing setup would just lose it.
      showToast(`認証情報の取得に失敗: ${err.message || 'unknown error'}`, 'error');
      return;
    }
  }

  applyUserToHeader(me);

  const onRepoChange = async (changeOrAddedId) => {
    // Backwards compat: a bare string means "added repo".
    const change =
      typeof changeOrAddedId === 'string' ? { added: changeOrAddedId } : changeOrAddedId || {};

    // Pause toggle: mutate the source of truth (`lastData.paused`) so
    // isRepoActive reflects it, then take the cheapest path that ends in
    // the right pixels:
    //   - Pausing: section just needs to disappear; rerender from lastData.
    //   - Unpausing: backend zeroed out `prs` for paused repos so a rerender
    //     would flash an empty section. Defer to loadSingleRepo, which
    //     fetches fresh PRs and re-renders the section in place.
    if (change.pauseChanged) {
      const target = lastData?.repos?.find((r) => r.repo === change.pauseChanged.repo);
      if (target) {
        target.paused = change.pauseChanged.paused;
        if (change.pauseChanged.paused) {
          rerenderFromLastData();
          updateStats(lastData);
        } else {
          // loadSingleRepo handles its own errors via toast/banner.
          loadSingleRepo(change.pauseChanged.repo);
        }
      }
      return;
    }

    await renderRepoList(onRepoChange);
    if (change.removed) {
      // Drop from lastData immediately so a subsequent rerender (sort change,
      // visibility toggle) doesn't resurrect the deleted repo if loadPRs fails.
      removeLastDataRepo(change.removed);
      // Persist the trimmed snapshot to localStorage and invalidate SW so
      // a hard reload (or SW offline fallback) doesn't bring back the
      // just-deleted repo from a stale cached /api/prs response.
      if (lastData) writeCache(CACHE_KEYS.prs, lastData);
      invalidateApiSwCache();
      // Repaint the dashboard from the locally-trimmed lastData first so the
      // user sees the repo disappear without a "loading" gap.
      rerenderFromLastData();
    }
    if (change.added) {
      await loadSingleRepo(change.added);
    } else {
      await loadPRs();
    }
  };

  initSidebar(onRepoChange);
  initSettings();
  initAiPanel();
  await renderRepoList(onRepoChange);

  // Initial scan: show repo selection screen if no repos watched
  const { repos: watchedRepos } = await api.repos();
  writeCache(CACHE_KEYS.repos, watchedRepos);
  if (watchedRepos.length === 0 && !hasRunInitialScan) {
    hasRunInitialScan = true;
    await showRepoSelectionScreen(onRepoChange);
  } else {
    startPolling();
  }

  // Logout
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    stopPolling();
    clearStoredToken();
    window.location.href = '/setup.html';
  });

  // Refresh
  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    if (
      !(await confirmDialog(
        '全リポジトリの最新データを取得します。GitHub API への負荷が高い処理です。実行しますか？',
      ))
    )
      return;

    setLoading(true, 'Refreshing PR data...');
    paneCache.clear();
    try {
      const data = await api.refreshPrs(true);
      lastData = data;
      // Persist + invalidate downstream caches so a hard reload right after
      // refresh doesn't show 5-minute-old data from the SW or 1-hour-old data
      // from localStorage. The backend POST /api/prs/refresh is not cached by
      // the SW (POST is bypassed) but the next GET /api/prs would HIT SW
      // cache without this.
      writeCache(CACHE_KEYS.prs, data);
      invalidateApiSwCache();
      rerenderFromLastData();
      hideBanner();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  });

  // PR sort — re-render from cached data instead of re-fetching from the server.
  const sortSelect = document.getElementById('pr-sort');
  if (sortSelect) {
    sortSelect.value = getSortKey();
    sortSelect.addEventListener('change', () => {
      // Preserve scroll position across the full re-render — without this the
      // page snaps back to the top whenever the sort changes, which is
      // disorienting when the user is mid-scroll deep into a long list.
      const main = document.querySelector('.main');
      const scrollTop = main ? main.scrollTop : window.scrollY;
      setSortKey(sortSelect.value);
      if (lastData) {
        rerenderFromLastData();
      } else {
        loadPRs();
      }
      requestAnimationFrame(() => {
        if (main) main.scrollTop = scrollTop;
        else window.scrollTo(0, scrollTop);
      });
    });
  }

  // PR title search — debounced to avoid full DOM scans on every keystroke.
  const searchInput = document.getElementById('pr-search');
  if (searchInput) {
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(applySearchFilter, 200);
    });
  }

  // Detail pane
  document.getElementById('detail-close')?.addEventListener('click', closeDetailPane);
  document.getElementById('detail-overlay')?.addEventListener('click', closeDetailPane);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetailPane();
  });

  // Hamburger
  document.getElementById('btn-hamburger')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('open');
  });

  document.getElementById('sidebar-overlay')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');
  });
}

init();
