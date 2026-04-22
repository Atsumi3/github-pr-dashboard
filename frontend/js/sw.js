const CACHE_VERSION = 'v3';
const API_CACHE = `api-cache-${CACHE_VERSION}`;
const API_PATH_PREFIX = '/api/';
// 15 min — aligned with local-cache.js's PRS_TTL_MS so the SW and the
// in-page localStorage layer expire as one. Mismatched TTLs created an
// awkward "SW expired but localStorage still hot" intermediate state.
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const CACHE_TRIM_INTERVAL = 10;
const CACHED_AT_HEADER = 'x-sw-cached-at';

let cachedToken = null;
let putCount = 0;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('api-cache-') && k !== API_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SET_TOKEN') {
    cachedToken = data.token || null;
  } else if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(caches.delete(API_CACHE));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(API_PATH_PREFIX)) return;
  event.respondWith(handleApi(req));
});

async function handleApi(request) {
  const headers = new Headers(request.headers);
  if (cachedToken && !headers.has('X-GitHub-Token')) {
    headers.set('X-GitHub-Token', cachedToken);
  }

  const init = {
    method: request.method,
    headers,
    mode: request.mode === 'navigate' ? 'cors' : request.mode,
    credentials: request.credentials,
    redirect: request.redirect,
    referrer: request.referrer,
    integrity: request.integrity,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      init.body = await request.clone().arrayBuffer();
    } catch {
      // body unavailable, send without
    }
  }

  const proxied = new Request(request.url, init);

  try {
    const response = await fetch(proxied);

    if (response.status === 401) {
      // Drop any stale entries for this user before they sign in again.
      await caches.delete(API_CACHE);
      await notifyLogoutRequired();
    }

    if (request.method === 'GET' && response.ok) {
      await putWithMetadata(request, response.clone());
    }

    return response;
  } catch (err) {
    if (request.method === 'GET') {
      const cached = await matchFresh(request);
      if (cached) return cached;
    }
    throw err;
  }
}

async function putWithMetadata(request, response) {
  try {
    const cache = await caches.open(API_CACHE);
    const stamped = await stampResponse(response);
    await cache.put(request, stamped);
    // cache.keys() in Cache Storage API has IndexedDB-backed latency, so amortize
    // the trim cost across many puts instead of running it on every write.
    putCount++;
    if (putCount % CACHE_TRIM_INTERVAL === 0) {
      await trimCache(cache);
    }
  } catch {
    // cache put failures are non-fatal
  }
}

async function stampResponse(response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, String(Date.now()));
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function matchFresh(request) {
  const cache = await caches.open(API_CACHE);
  const hit = await cache.match(request);
  if (!hit) return null;
  const stamp = Number(hit.headers.get(CACHED_AT_HEADER) || 0);
  if (!stamp || Date.now() - stamp > CACHE_TTL_MS) {
    await cache.delete(request);
    return null;
  }
  return hit;
}

async function trimCache(cache) {
  const requests = await cache.keys();
  if (requests.length <= CACHE_MAX_ENTRIES) return;
  const overflow = requests.length - CACHE_MAX_ENTRIES;
  // keys() returns oldest first; delete from the front.
  for (let i = 0; i < overflow; i++) {
    await cache.delete(requests[i]);
  }
}

async function notifyLogoutRequired() {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'LOGOUT_REQUIRED' });
    }
  } catch {
    // ignore
  }
}
