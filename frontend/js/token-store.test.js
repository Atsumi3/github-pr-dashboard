import assert from 'node:assert/strict';
import test from 'node:test';
import { CACHE_KEYS, readCache, writeCache } from './local-cache.js';
import { clearToken, setToken } from './token-store.js';

function installLocalStorage(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const entries = new Map();
  const storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
    key: (index) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  return storage;
}

test('token insertion and replacement clear persisted review tracking', (t) => {
  const storage = installLocalStorage(t);
  storage.setItem('gh-token', 'old-token');
  writeCache(CACHE_KEYS.reviewTracker, { userLogin: 'octocat' });

  setToken('new-token');

  assert.equal(readCache(CACHE_KEYS.reviewTracker), null);

  writeCache(CACHE_KEYS.reviewTracker, { userLogin: 'octocat' });
  storage.removeItem('gh-token');
  setToken('first-token');

  assert.equal(readCache(CACHE_KEYS.reviewTracker), null);
});

test('logout clears persisted review tracking', (t) => {
  const storage = installLocalStorage(t);
  storage.setItem('gh-token', 'token');
  writeCache(CACHE_KEYS.reviewTracker, { userLogin: 'octocat' });

  clearToken();

  assert.equal(readCache(CACHE_KEYS.reviewTracker), null);
  assert.equal(storage.getItem('gh-token'), null);
});
