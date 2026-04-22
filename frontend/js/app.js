import { api, getStoredToken, clearStoredToken } from './api.js';
import {
  initSidebar,
  renderRepoList,
  initSettings,
  initAiPanel,
  refreshAiPanel,
  isAiAvailable,
  onAiAvailabilityChange,
  showToast,
  isRepoVisible,
  confirmDialog,
} from './settings.js';
import { readCache, writeCache, CACHE_KEYS } from './local-cache.js';

let pollTimer = null;
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

function applySearchFilter() {
  const input = document.getElementById('pr-search');
  if (!input) return;
  const q = input.value.trim().toLowerCase();
  const cards = document.querySelectorAll('.pr-card');
  const visibleByRepo = new Map();
  cards.forEach((card) => {
    const matches = !q || (card.dataset.search || '').includes(q);
    const next = matches ? '' : 'none';
    if (card.style.display !== next) card.style.display = next;
    const repoId = card.closest('.repo-section')?.dataset.repo;
    if (repoId && matches) visibleByRepo.set(repoId, (visibleByRepo.get(repoId) || 0) + 1);
  });
  document.querySelectorAll('.repo-section').forEach((section) => {
    const repoId = section.dataset.repo;
    const hasContent = (visibleByRepo.get(repoId) || 0) > 0;
    const isHiddenByVisibility = !isRepoVisible(repoId);
    const next = hasContent && !isHiddenByVisibility ? '' : 'none';
    if (section.style.display !== next) section.style.display = next;
  });
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

  card.addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // Don't intercept link clicks
    openDetailPane(prOwner, prRepo, pr.number, pr.title);
  });

  // Row 1: number + title + created
  const row1 = document.createElement('div');
  row1.className = 'pr-row1';
  const row1Left = document.createElement('div');
  row1Left.className = 'pr-row1-left';
  const num = document.createElement('span');
  num.className = 'pr-number';
  num.textContent = `#${pr.number}`;
  const title = document.createElement('a');
  title.className = 'pr-title';
  title.href = pr.url;
  title.target = '_blank';
  title.rel = 'noopener';
  title.textContent = pr.title;
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
  if (!isRepoVisible(repoData.repo)) section.style.display = 'none';

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

  if (repoData.paused) {
    const badge = document.createElement('span');
    badge.className = 'repo-paused-badge';
    badge.textContent = '⏸ Paused';
    badge.title = 'ポーリングが停止されています';
    header.appendChild(badge);
    section.classList.add('repo-paused');
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
      const loadMore = document.createElement('button');
      loadMore.className = 'load-more-btn';
      loadMore.textContent = `Load more (${sorted.length - limit} more)`;
      loadMore.addEventListener('click', () => {
        const newLimit =
          (displayLimit.get(repoData.repo) || INITIAL_DISPLAY_LIMIT) + LOAD_MORE_INCREMENT;
        displayLimit.set(repoData.repo, newLimit);
        renderCardsInGrid(grid, sorted, newLimit);
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
    reapplySearchFilter();
  } catch (err) {
    loadingSection.remove();
    upsertLastDataRepo({
      repo: repoId,
      prs: [],
      error: err.message,
      paused: lastDataPaused(repoId),
    });
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
  const existingByRepo = new Map();
  for (const node of Array.from(main.children)) {
    const id = node.dataset?.repo;
    if (id) {
      existingByRepo.set(id, node);
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
    if (!isRepoVisible(repo.repo)) continue;
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

  titleEl.textContent = `#${number} ${title}`;
  content.textContent = '';

  pane.classList.remove('hidden');
  overlay.classList.remove('hidden');

  sweepPaneCache();

  const key = `${owner}/${repo}#${number}`;
  const cached = paneCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < DETAIL_CACHE_TTL) {
    renderDetailContent(content, cached.data);
    return;
  }

  const loadingEl = document.createElement('div');
  loadingEl.className = 'detail-loading';
  loadingEl.textContent = 'Loading...';
  content.appendChild(loadingEl);

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

async function runSummarize(card, btn, text) {
  let summaryEl = card.querySelector('.detail-ai-summary');
  if (summaryEl) summaryEl.remove();

  summaryEl = document.createElement('div');
  summaryEl.className = 'detail-ai-summary loading';
  summaryEl.textContent = 'AI で要約中...';
  card.appendChild(summaryEl);
  btn.disabled = true;
  btn.textContent = '要約中...';

  try {
    const { summary, cli } = await api.aiSummarize(text);
    summaryEl.classList.remove('loading');
    summaryEl.textContent = '';
    const label = document.createElement('div');
    label.className = 'detail-ai-summary-label';
    label.textContent = `Summary (${cli || 'AI'})`;
    summaryEl.appendChild(label);
    const body = document.createElement('div');
    body.className = 'detail-ai-summary-body';
    body.textContent = summary;
    summaryEl.appendChild(body);
  } catch (err) {
    summaryEl.classList.remove('loading');
    summaryEl.classList.add('error');
    summaryEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'AIで要約';
  }
}

async function runPRSummarize(host, btn, detail) {
  let summaryEl = host.querySelector('.detail-ai-summary');
  if (summaryEl) summaryEl.remove();

  summaryEl = document.createElement('div');
  summaryEl.className = 'detail-ai-summary loading';
  summaryEl.textContent = 'AI で PR を要約中...';
  host.appendChild(summaryEl);
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = '要約中...';

  try {
    const files = (detail.files || []).map((f) => ({
      filename: f.filename,
      additions: f.additions || 0,
      deletions: f.deletions || 0,
    }));
    const { summary, cli } = await api.aiSummarizePR({
      title: detail.title || '',
      body: detail.body || '',
      files,
    });
    summaryEl.classList.remove('loading');
    summaryEl.textContent = '';
    const label = document.createElement('div');
    label.className = 'detail-ai-summary-label';
    label.textContent = `PR Summary (${cli || 'AI'})`;
    summaryEl.appendChild(label);
    const body = document.createElement('div');
    body.className = 'detail-ai-summary-body';
    body.textContent = summary;
    summaryEl.appendChild(body);
  } catch (err) {
    summaryEl.remove();
    showToast(`PR要約に失敗: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function closeDetailPane() {
  document.getElementById('detail-pane').classList.add('hidden');
  document.getElementById('detail-overlay').classList.add('hidden');
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

  if (isAiAvailable()) {
    summarizePrBtn = document.createElement('button');
    summarizePrBtn.className = 'detail-pr-summary-btn';
    summarizePrBtn.textContent = 'PR全体をAIで要約';
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

  // Files
  if (detail.files.length > 0) {
    const filesTitle = document.createElement('div');
    filesTitle.className = 'detail-section-title';
    filesTitle.textContent = `Files (${detail.files.length})`;
    container.appendChild(filesTitle);

    const fileList = document.createElement('div');
    fileList.className = 'detail-file-list';

    detail.files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'detail-file';

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

      fileList.appendChild(row);
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

      if (isAiAvailable()) {
        const aiBtn = document.createElement('button');
        aiBtn.className = 'detail-ai-btn';
        aiBtn.textContent = 'AIで要約';
        aiBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const allText = thread.comments
            .map((c) => `${c.author?.login || 'unknown'}: ${c.body}`)
            .join('\n\n');
          await runSummarize(card, aiBtn, allText);
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

async function startPolling({ skipImmediate = false } = {}) {
  stopPolling();
  // Tag this invocation; if a newer startPolling races us across the
  // `await api.settings()` (e.g. visibilitychange + loadSingleRepo finally),
  // the older call must drop its setInterval to avoid leaking a duplicate.
  const callId = ++pollingCallId;
  try {
    const settings = await api.settings();
    if (callId !== pollingCallId) return;
    const interval = settings.pollInterval * 1000;
    if (!skipImmediate) await loadPRs();
    if (callId !== pollingCallId) return;
    pollTimer = setInterval(loadPRs, interval);
  } catch {
    if (callId !== pollingCallId) return;
    if (!skipImmediate) await loadPRs();
    if (callId !== pollingCallId) return;
    pollTimer = setInterval(loadPRs, 60_000);
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Page Visibility API — pause both the data poller and the per-second
// "last updated" timer when the tab isn't visible to avoid background CPU.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
    stopLastUpdatedTimer();
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
  } catch {
    clearStoredToken();
    window.location.href = '/setup.html';
    return;
  }

  applyUserToHeader(me);

  const onRepoChange = async (changeOrAddedId) => {
    // Backwards compat: a bare string means "added repo".
    const change =
      typeof changeOrAddedId === 'string' ? { added: changeOrAddedId } : changeOrAddedId || {};

    // Lightweight in-place update: pause toggle doesn't need a server refetch
    // or full sidebar rebuild. Just sync lastData so subsequent rerenders show
    // the paused badge correctly.
    if (change.pauseChanged) {
      const target = lastData?.repos?.find((r) => r.repo === change.pauseChanged.repo);
      if (target) target.paused = change.pauseChanged.paused;
      return;
    }

    await renderRepoList(onRepoChange);
    if (change.removed) {
      // Drop from lastData immediately so a subsequent rerender (sort change,
      // visibility toggle) doesn't resurrect the deleted repo if loadPRs fails.
      removeLastDataRepo(change.removed);
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
      setSortKey(sortSelect.value);
      if (lastData) {
        rerenderFromLastData();
      } else {
        loadPRs();
      }
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
