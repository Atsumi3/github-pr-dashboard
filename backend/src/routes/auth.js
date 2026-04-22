import { Router } from 'express';
import * as github from '../github.js';
import { ERROR_CODES, sendError } from '../httpError.js';

const router = Router();

router.get('/api/auth/me', async (req, res) => {
  try {
    const user = await github.getUser(req.token);
    res.json({ user });
  } catch (err) {
    console.error('Auth: failed to verify GitHub token', err.message);
    sendError(res, 401, ERROR_CODES.GITHUB_TOKEN_EXPIRED, 'GitHub token is invalid or expired');
  }
});

export default router;
