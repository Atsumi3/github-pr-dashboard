import { api } from './api.js';

let searchTimeout = null;

export function initSidebar(onRepoChange) {
  const searchInput = document.getElementById('repo-search');
  const dropdown = document.getElementById('search-dropdown');

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      dropdown.classList.add('hidden');
      return;
    }
    searchTimeout = setTimeout(async () => {
      try {
        const { items } = await api.searchRepos(q);
        renderDropdown(items, dropdown, searchInput, onRepoChange);
      } catch {
        clearDropdown(dropdown);
        appendDropdownMessage(dropdown, 'Search failed');
      }
    }, 300);
  });

  searchInput.addEventListener('focus', () => {
    if (dropdown.children.length > 0 && searchInput.value.trim().length >= 2) {
      dropdown.classList.remove('hidden');
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sidebar-search')) {
      dropdown.classList.add('hidden');
    }
  });
}

function clearDropdown(dropdown) {
  while (dropdown.firstChild) dropdown.firstChild.remove();
  dropdown.classList.remove('hidden');
}

function appendDropdownMessage(dropdown, text) {
  const div = document.createElement('div');
  div.className = 'search-result';
  const span = document.createElement('span');
  span.className = 'search-result-desc';
  span.textContent = text;
  div.appendChild(span);
  dropdown.appendChild(div);
}

function renderDropdown(items, dropdown, searchInput, onRepoChange) {
  clearDropdown(dropdown);

  if (items.length === 0) {
    appendDropdownMessage(dropdown, 'No repositories found');
    return;
  }

  items.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'search-result';
    div.dataset.repo = item.fullName;

    const nameEl = document.createElement('div');
    nameEl.className = 'search-result-name';
    nameEl.textContent = item.fullName;
    div.appendChild(nameEl);

    const descEl = document.createElement('div');
    descEl.className = 'search-result-desc';
    descEl.textContent = item.description;
    div.appendChild(descEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'search-result-meta';
    metaEl.textContent = item.private ? 'Private' : 'Public';
    div.appendChild(metaEl);

    div.addEventListener('click', async () => {
      try {
        await api.addRepo(item.fullName);
        showToast(`${item.fullName} added to watch list`);
        searchInput.value = '';
        dropdown.classList.add('hidden');
        onRepoChange(item.fullName);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    dropdown.appendChild(div);
  });
}

const EYE_OPEN_PATH =
  'M1.679 7.932c.412-.621 1.242-1.75 2.366-2.717C5.175 4.242 6.527 3.5 8 3.5s2.825.742 3.955 1.715c1.124.967 1.954 2.096 2.366 2.717a.119.119 0 010 .136c-.412.621-1.242 1.75-2.366 2.717C10.825 11.758 9.473 12.5 8 12.5s-2.825-.742-3.955-1.715C2.92 9.818 2.09 8.689 1.679 8.068a.119.119 0 010-.136zM8 2c-1.981 0-3.67.992-4.933 2.078C1.797 5.169.88 6.423.43 7.1a1.619 1.619 0 000 1.798c.45.678 1.367 1.932 2.637 3.024C4.329 13.008 6.019 14 8 14c1.981 0 3.67-.992 4.933-2.078 1.27-1.091 2.187-2.345 2.637-3.023a1.619 1.619 0 000-1.798c-.45-.678-1.367-1.932-2.637-3.023C11.671 2.992 9.981 2 8 2zm0 8a2 2 0 100-4 2 2 0 000 4z';
const EYE_CLOSED_PATH =
  'M.143 2.31a.75.75 0 011.047-.167l14.5 10.5a.75.75 0 11-.88 1.214l-2.248-1.628C11.346 13.323 9.792 14 8 14c-1.981 0-3.67-.992-4.933-2.078C1.797 10.832.88 9.577.43 8.9a1.619 1.619 0 010-1.798c.529-.795 1.625-2.227 3.149-3.355L.31 3.357A.75.75 0 01.143 2.31zm1.536 5.622A14.067 14.067 0 002.625 9.4l.012.014c.41.587 1.082 1.367 1.962 1.957L4.6 11.4l5.69 4.117zm12.642-.864a.119.119 0 010 .136c-.328.494-.916 1.31-1.708 2.107l-1.097-.795A2 2 0 008.087 6.012L5.97 4.479A6.95 6.95 0 018 4c1.473 0 2.825.742 3.955 1.715 1.124.967 1.954 2.096 2.366 2.717z';

function setEyeIcon(btn, visible) {
  while (btn.firstChild) btn.firstChild.remove();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', visible ? EYE_OPEN_PATH : EYE_CLOSED_PATH);
  svg.appendChild(path);
  btn.appendChild(svg);
}

// One-shot removal of the visibility key used by the pre-unification UI.
// Safe to drop after one release cycle.
const LEGACY_HIDDEN_REPOS_KEY = 'pr-dashboard-hidden-repos';
export function cleanupLegacyStorage() {
  try {
    localStorage.removeItem(LEGACY_HIDDEN_REPOS_KEY);
  } catch {
    // ignore — quota / privacy mode
  }
}

export async function renderRepoList(onRepoChange) {
  const list = document.getElementById('repo-list');
  while (list.firstChild) list.firstChild.remove();

  try {
    const { repos } = await api.repos();

    repos.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'sidebar-item';
      let active = !r.paused;
      if (!active) div.classList.add('repo-item-paused');

      // The eye icon is the single affordance for both UI visibility and
      // server-side polling — paused === !visible.
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'repo-visibility-btn';
      if (!active) toggleBtn.classList.add('hidden-repo');
      const labelFor = (a) =>
        a ? `${r.id} を非表示にして更新を停止` : `${r.id} を表示して更新を再開`;
      const titleFor = (a) =>
        a
          ? '表示+更新中（クリックで非表示にして更新も停止）'
          : '非表示+更新停止中（クリックで表示と更新を再開）';
      toggleBtn.setAttribute('aria-label', labelFor(active));
      toggleBtn.title = titleFor(active);
      setEyeIcon(toggleBtn, active);

      const setActive = async (next) => {
        if (next === active) return;
        const [owner, name] = r.id.split('/');
        try {
          await api.setRepoPaused(owner, name, !next);
          active = next;
          toggleBtn.classList.toggle('hidden-repo', !next);
          div.classList.toggle('repo-item-paused', !next);
          toggleBtn.setAttribute('aria-label', labelFor(next));
          toggleBtn.title = titleFor(next);
          setEyeIcon(toggleBtn, next);
          onRepoChange({ pauseChanged: { repo: r.id, paused: !next } });
          showToast(next ? `${r.id} を表示して更新を再開` : `${r.id} を非表示にして更新を停止`);
        } catch (err) {
          showToast(err.message, 'error');
        }
      };

      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setActive(!active);
      });
      div.appendChild(toggleBtn);

      const span = document.createElement('span');
      span.className = 'repo-item-name';
      span.textContent = r.id;
      div.appendChild(span);

      div.addEventListener('click', async (e) => {
        if (e.target.closest('.repo-visibility-btn') || e.target.closest('.delete-btn')) return;
        // Resume first so the section exists by the time we try to scroll.
        if (!active) await setActive(true);
        const target = document.querySelector(`.repo-section[data-repo="${r.id}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      const btn = document.createElement('button');
      btn.className = 'delete-btn';
      btn.textContent = 'x';
      btn.setAttribute('aria-label', `Remove ${r.id}`);
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog(`${r.id} を監視リストから削除しますか？`))) return;
        const [owner, name] = r.id.split('/');
        try {
          await api.removeRepo(owner, name);
          showToast(`${r.id} removed`);
          onRepoChange({ removed: r.id });
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      div.appendChild(btn);

      list.appendChild(div);
    });
  } catch {
    const div = document.createElement('div');
    div.className = 'sidebar-item';
    div.textContent = 'Failed to load';
    list.appendChild(div);
  }
}

export function initSettings() {
  const presets = document.getElementById('poll-presets');
  if (!presets) return;

  const buttons = presets.querySelectorAll('.poll-preset');

  function highlight(seconds) {
    buttons.forEach((b) => {
      const v = parseInt(b.dataset.seconds, 10);
      b.classList.toggle('active', v === seconds);
    });
  }

  api.settings().then((s) => highlight(s.pollInterval));

  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const seconds = parseInt(btn.dataset.seconds, 10);
      const prev = [...buttons].find((b) => b.classList.contains('active'));
      highlight(seconds);
      try {
        await api.updateSettings({ pollInterval: seconds });
        showToast(`Auto-refresh set to ${btn.textContent}`);
      } catch (err) {
        // revert highlight on failure
        if (prev) highlight(parseInt(prev.dataset.seconds, 10));
        showToast(err.message, 'error');
      }
    });
  });
}

// AI status panel — fetches /api/ai/status and renders the CLI list at the
// bottom of the sidebar. Auto-refreshes when settings dialog saves config.
let aiStatusCache = null;
const aiAvailabilityListeners = new Set();

// True when ai-server responds AND the configured CLI is actually installed.
// Frontend uses this to gate AI buttons (graceful degradation when ai-server
// is not running).
export function isAiAvailable() {
  if (!aiStatusCache) return false;
  const cli = aiStatusCache.cli;
  if (!cli) return false;
  return aiStatusCache.available?.[cli]?.available === true;
}

export function onAiAvailabilityChange(listener) {
  aiAvailabilityListeners.add(listener);
  return () => aiAvailabilityListeners.delete(listener);
}

function setAiStatusCache(next) {
  const before = isAiAvailable();
  aiStatusCache = next;
  const after = isAiAvailable();
  if (before !== after) {
    for (const fn of aiAvailabilityListeners) {
      try {
        fn(after);
      } catch (err) {
        console.warn('AI availability listener threw:', err);
      }
    }
  }
}

export async function initAiPanel() {
  const btn = document.getElementById('btn-ai-settings');
  if (!btn) return;
  btn.addEventListener('click', () => openAiSettingsDialog());
  await refreshAiPanel();
}

export async function refreshAiPanel() {
  const list = document.getElementById('ai-status-list');
  if (!list) return;
  while (list.firstChild) list.firstChild.remove();
  try {
    const status = await api.aiStatus();
    setAiStatusCache(status);
    renderAiStatusList(list, status);
  } catch (err) {
    setAiStatusCache(null);
    const msg = document.createElement('div');
    msg.className = 'ai-status-offline';
    msg.textContent =
      err.code === 'AI_SERVER_UNAVAILABLE' ? 'ai-server 未起動' : `エラー: ${err.message}`;
    list.appendChild(msg);
  }
}

function renderAiStatusList(list, status) {
  for (const name of status.knownClis || []) {
    const info = status.available?.[name] || {};
    const row = document.createElement('div');
    row.className = 'ai-status-row';
    if (name === status.cli) row.classList.add('active');
    if (!info.available) row.classList.add('unavailable');

    const dot = document.createElement('span');
    dot.className = 'ai-status-dot';
    row.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'ai-status-label';
    label.textContent = name;
    row.appendChild(label);

    const tag = document.createElement('span');
    tag.className = 'ai-status-tag';
    tag.textContent = name === status.cli ? '使用中' : info.available ? '利用可' : '未インストール';
    row.appendChild(tag);

    list.appendChild(row);
  }
  if (!status.secretConfigured) {
    const warn = document.createElement('div');
    warn.className = 'ai-status-warn';
    warn.textContent = 'AI_SHARED_SECRET 未設定 (任意リクエストが通る)';
    list.appendChild(warn);
  }
}

export function openAiSettingsDialog() {
  // Use the cached status if available; otherwise fetch fresh.
  const ready = aiStatusCache ? Promise.resolve(aiStatusCache) : api.aiStatus();
  ready
    .then((status) => renderAiSettingsDialog(status))
    .catch((err) => showToast(err.message, 'error'));
}

function renderAiSettingsDialog(status) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const dialog = document.createElement('div');
  dialog.className = 'confirm-dialog ai-settings-dialog';

  const heading = document.createElement('div');
  heading.className = 'ai-settings-heading';
  heading.textContent = 'AI 要約の設定';
  dialog.appendChild(heading);

  // CLI dropdown
  const cliRow = document.createElement('div');
  cliRow.className = 'ai-settings-row';
  const cliLabel = document.createElement('label');
  cliLabel.textContent = '使用する CLI';
  cliLabel.htmlFor = 'ai-cli-select';
  cliRow.appendChild(cliLabel);
  const cliSelect = document.createElement('select');
  cliSelect.id = 'ai-cli-select';
  for (const name of status.knownClis || []) {
    const opt = document.createElement('option');
    opt.value = name;
    const info = status.available?.[name] || {};
    opt.textContent = info.available ? name : `${name} (未インストール)`;
    if (!info.available) opt.disabled = true;
    if (name === status.cli) opt.selected = true;
    cliSelect.appendChild(opt);
  }
  cliRow.appendChild(cliSelect);
  dialog.appendChild(cliRow);

  // Prompt editors
  const promptRow1 = document.createElement('div');
  promptRow1.className = 'ai-settings-row';
  const p1Label = document.createElement('label');
  p1Label.textContent = 'System prompt: コメント要約';
  p1Label.htmlFor = 'ai-prompt-summarize';
  promptRow1.appendChild(p1Label);
  const p1Hint = document.createElement('div');
  p1Hint.className = 'ai-settings-hint';
  p1Hint.textContent = '/api/ai/summarize で先頭に挿入されます。';
  promptRow1.appendChild(p1Hint);
  const p1Area = document.createElement('textarea');
  p1Area.id = 'ai-prompt-summarize';
  p1Area.className = 'ai-prompt-textarea';
  p1Area.rows = 5;
  p1Area.value = status.prompts?.summarize || '';
  promptRow1.appendChild(p1Area);
  const p1Reset = document.createElement('button');
  p1Reset.type = 'button';
  p1Reset.className = 'ai-prompt-reset';
  p1Reset.textContent = 'デフォルトに戻す';
  p1Reset.addEventListener('click', () => {
    p1Area.value = status.defaults?.summarize || '';
  });
  promptRow1.appendChild(p1Reset);
  dialog.appendChild(promptRow1);

  const promptRow2 = document.createElement('div');
  promptRow2.className = 'ai-settings-row';
  const p2Label = document.createElement('label');
  p2Label.textContent = 'System prompt: PR 要約';
  p2Label.htmlFor = 'ai-prompt-summarize-pr';
  promptRow2.appendChild(p2Label);
  const p2Hint = document.createElement('div');
  p2Hint.className = 'ai-settings-hint';
  p2Hint.textContent = '/api/ai/summarize-pr で先頭に挿入されます。';
  promptRow2.appendChild(p2Hint);
  const p2Area = document.createElement('textarea');
  p2Area.id = 'ai-prompt-summarize-pr';
  p2Area.className = 'ai-prompt-textarea';
  p2Area.rows = 7;
  p2Area.value = status.prompts?.summarizePr || '';
  promptRow2.appendChild(p2Area);
  const p2Reset = document.createElement('button');
  p2Reset.type = 'button';
  p2Reset.className = 'ai-prompt-reset';
  p2Reset.textContent = 'デフォルトに戻す';
  p2Reset.addEventListener('click', () => {
    p2Area.value = status.defaults?.summarizePr || '';
  });
  promptRow2.appendChild(p2Reset);
  dialog.appendChild(promptRow2);

  // Meta info
  const meta = document.createElement('div');
  meta.className = 'ai-settings-meta';
  const installed = Object.entries(status.available || {})
    .filter(([, v]) => v.available)
    .map(([k, v]) => `${k}: ${v.path}`)
    .join('\n');
  meta.textContent = `[インストール済み]\n${installed || '(none)'}\n\n[Timeout] ${status.timeoutMs}ms\n[Secret] ${status.secretConfigured ? 'set' : 'NOT SET'}`;
  dialog.appendChild(meta);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'confirm-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'confirm-btn confirm-btn-cancel';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'confirm-btn confirm-btn-ok';
  saveBtn.textContent = '保存';

  actions.append(cancelBtn, saveBtn);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    }
  };

  cancelBtn.addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKey);

  saveBtn.addEventListener('click', async () => {
    // Catch the edge case where the previously-active CLI was uninstalled
    // since the page loaded — without this, the user sees a generic 400 from
    // ai-server with no clue about why.
    const chosenCli = cliSelect.value;
    if (!status.available?.[chosenCli]?.available) {
      showToast(`${chosenCli} はホストにインストールされていません`, 'error');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    try {
      const updated = await api.updateAiConfig({
        cli: chosenCli,
        prompts: {
          summarize: p1Area.value,
          summarizePr: p2Area.value,
        },
      });
      setAiStatusCache(updated);
      const list = document.getElementById('ai-status-list');
      if (list) {
        while (list.firstChild) list.firstChild.remove();
        renderAiStatusList(list, updated);
      }
      showToast('AI 設定を保存しました');
      cleanup();
    } catch (err) {
      showToast(err.message, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  });

  cliSelect.focus();
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const msg = document.createElement('div');
    msg.className = 'confirm-message';
    msg.textContent = message;
    dialog.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-btn confirm-btn-cancel';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'confirm-btn confirm-btn-ok';
    okBtn.textContent = 'OK';

    actions.append(cancelBtn, okBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(true);
      }
    };

    cancelBtn.addEventListener('click', () => cleanup(false));
    okBtn.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });
    document.addEventListener('keydown', onKey);

    // Focus the cancel button by default for safety
    cancelBtn.focus();
  });
}

// Toast queue with three behaviours users actually want:
// 1) Same message twice → coalesce into one toast with a `×N` badge so a
//    storm of identical errors doesn't carpet the corner.
// 2) Cap simultaneous toasts at TOAST_MAX so the search box isn't buried
//    when several repos rate-limit at once.
// 3) Manual close button so a sticky error doesn't block UI for 5s.
const TOAST_MAX = 3;
const TOAST_TTL_MS = 5000;
const toastByMessage = new Map();

function removeToast(message) {
  const entry = toastByMessage.get(message);
  if (!entry) return;
  clearTimeout(entry.timer);
  toastByMessage.delete(message);
  entry.el.classList.add('toast-fade');
  setTimeout(() => entry.el.remove(), 300);
}

export function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const existing = toastByMessage.get(message);
  if (existing) {
    existing.count += 1;
    if (!existing.badgeEl) {
      existing.badgeEl = document.createElement('span');
      existing.badgeEl.className = 'toast-badge';
      existing.el.insertBefore(existing.badgeEl, existing.closeBtn);
    }
    existing.badgeEl.textContent = `×${existing.count}`;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => removeToast(message), TOAST_TTL_MS);
    return;
  }

  while (toastByMessage.size >= TOAST_MAX) {
    const oldest = toastByMessage.keys().next().value;
    removeToast(oldest);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  if (type === 'error') toast.setAttribute('role', 'alert');

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.appendChild(text);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => removeToast(message));
  toast.appendChild(closeBtn);

  container.appendChild(toast);

  toastByMessage.set(message, {
    el: toast,
    count: 1,
    badgeEl: null,
    closeBtn,
    timer: setTimeout(() => removeToast(message), TOAST_TTL_MS),
  });
}
