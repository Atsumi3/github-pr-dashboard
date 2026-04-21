import { clearAllCaches } from './local-cache.js';

const KEY = 'gh-token';

export function getToken() {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function setToken(token) {
  if (!token) return;
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // ignore quota / privacy mode
  }
  syncTokenToServiceWorker(token);
}

export function clearToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  clearAllCaches();
  syncTokenToServiceWorker(null);
  clearServiceWorkerCache();
}

function clearServiceWorkerCache() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  controller.postMessage({ type: 'CLEAR_CACHE' });
}

export function syncTokenToServiceWorker(token) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  controller.postMessage({ type: 'SET_TOKEN', token: token ?? null });
}
