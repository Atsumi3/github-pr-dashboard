import { getToken, setToken, clearToken } from './token-store.js';

// Backward-compatible re-exports.
export const getStoredToken = getToken;
export const setStoredToken = setToken;
export const clearStoredToken = clearToken;

async function request(method, path, body) {
  const token = getToken();
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };
  if (token) opts.headers['X-GitHub-Token'] = token;
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 401) {
      clearToken();
    }
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

export const api = {
  authMe: () => request('GET', '/api/auth/me'),
  repos: () => request('GET', '/api/repos'),
  addRepo: (repo) => request('POST', '/api/repos', { repo }),
  suggestions: () => request('GET', '/api/repos/suggestions'),
  removeRepo: (owner, name) => request('DELETE', `/api/repos/${owner}/${name}`),
  setRepoPaused: (owner, name, paused) => request('PATCH', `/api/repos/${owner}/${name}`, { paused }),
  searchRepos: (q) => request('GET', `/api/repos/search?q=${encodeURIComponent(q)}`),
  prs: (assignee) => request('GET', assignee ? '/api/prs?assignee=me' : '/api/prs'),
  prsForRepo: (owner, repo, assignee) => request('GET', `/api/prs/repo/${owner}/${repo}${assignee ? '?assignee=me' : ''}`),
  prDetail: (owner, repo, number) => request('GET', `/api/prs/${owner}/${repo}/${number}`),
  aiSummarize: (text) => request('POST', '/api/ai/summarize', { text }),
  aiSummarizePR: (prData) => request('POST', '/api/ai/summarize-pr', prData),
  aiStatus: () => request('GET', '/api/ai/status'),
  updateAiConfig: (config) => request('PUT', '/api/ai/config', config),
  refreshPrs: (assignee) => request('POST', assignee ? '/api/prs/refresh?assignee=me' : '/api/prs/refresh'),
  settings: () => request('GET', '/api/settings'),
  updateSettings: (settings) => request('PUT', '/api/settings', settings),
};
