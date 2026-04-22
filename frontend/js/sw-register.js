import { getToken, syncTokenToServiceWorker } from './token-store.js';

if ('serviceWorker' in navigator) {
  // Explicit scope is required; default scope is the directory of the script
  // (/js/), which would skip /api/* fetches entirely. Server also sets
  // Service-Worker-Allowed: / on /js/sw.js to permit this override.
  navigator.serviceWorker
    .register('/js/sw.js', { scope: '/' })
    .then(() => {
      const sendIfReady = () => {
        const token = getToken();
        if (token) syncTokenToServiceWorker(token);
      };
      if (navigator.serviceWorker.controller) {
        sendIfReady();
      } else {
        navigator.serviceWorker.addEventListener('controllerchange', sendIfReady, { once: true });
      }
    })
    .catch(() => {
      // SW registration failure is non-fatal; api.js still attaches the header.
    });
}
