// Setup page boot script. Extracted from setup.html so the CSP can drop
// `script-src 'unsafe-inline'` (a single inline <script> was the only thing
// keeping it alive).
import { api, getStoredToken, setStoredToken, clearStoredToken } from '/js/api.js';

const errEl = document.getElementById('login-error');
const btnPat = document.getElementById('btn-pat');
const patInput = document.getElementById('pat-input');

// Already authenticated? Verify token still works against GitHub.
if (getStoredToken()) {
  try {
    await api.authMe();
    window.location.href = '/';
  } catch {
    // Stored token is invalid/expired — clear and stay on this page.
    clearStoredToken();
  }
}

btnPat.addEventListener('click', async () => {
  errEl.classList.add('hidden');
  const pat = patInput.value.trim();
  if (!pat) {
    errEl.textContent = 'Token を入力してください';
    errEl.classList.remove('hidden');
    return;
  }

  btnPat.disabled = true;
  btnPat.textContent = 'Connecting...';

  try {
    // Store first so api.authMe() picks it up via the X-GitHub-Token header.
    setStoredToken(pat);
    await api.authMe();
    window.location.href = '/';
  } catch (err) {
    clearStoredToken();
    // Don't leave the failed PAT visible in the input — shoulder surfing /
    // browser autofill could pick it up.
    patInput.value = '';
    errEl.textContent = err.message || 'Token verification failed';
    errEl.classList.remove('hidden');
    btnPat.disabled = false;
    btnPat.textContent = '接続';
  }
});

patInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnPat.click();
});
