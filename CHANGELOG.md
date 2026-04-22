# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-04-22

Initial public release.

### Features

- Repository-grouped dashboard of open Pull Requests across multiple watched
  repos, color-coded by review status (Approved / Changes Requested / Pending /
  Review Required)
- Detail pane: changed files, unresolved review threads, failed CI checks
  linked to GitHub Actions logs, and AI summary (claude / codex / gemini /
  chatgpt CLI) with an "always verify the original" disclaimer
- Browser notifications on new PRs and review-status changes (foreground +
  5-minute background polling so notifications keep firing on hidden tabs)
- Single eye icon per repo unifies "show in UI" and "poll the GitHub API" —
  pausing skips the API call entirely, with backend `paused` as the single
  source of truth
- Server-side filter: `assignee=me` is dispatched as a chunked GitHub GraphQL
  search (`involves:USER` + `review-requested:USER`) instead of fetching every
  PR and filtering client-side
- Three-layer cache: backend in-memory (TTL = pollInterval) / Service Worker
  (15 min, used as offline fallback) / localStorage (instant repaint after a
  hard reload)

### Security

- AI server requires `AI_SHARED_SECRET` (FATAL exit if unset, opt-out via
  `AI_REQUIRE_SECRET=0` with per-request `[INSECURE]` warning)
- AI server CLI is whitelisted (`claude` / `codex` / `gemini` / `chatgpt`),
  Host-header allowlist mitigates DNS rebinding, and `cliArgs` cannot be set
  via API
- Backend Origin / Referer guard (`ALLOWED_ORIGINS`)
- Token-change detection in auth middleware drops PR / detail caches so a new
  GitHub identity never sees a frame of the previous user's data
- AI prompt updates require `X-Confirm-Ai-Config: 1` header to mitigate XSS
  driven prompt rewrites
- Strict CSP (`script-src 'self'`, no `unsafe-inline` for scripts; `style-src`
  retains `'unsafe-inline'` for runtime label colors)
- Client-facing error messages are sanitized; details only go to console.error
- 401 responses only wipe the stored PAT when the backend reports
  `GITHUB_TOKEN_EXPIRED`, preserving the token across transient failures

### Tooling

- ESLint 9 (flat config) + Prettier wired through pnpm scripts (`pnpm lint`,
  `pnpm format`)
- GitHub Actions: `lint` workflow on push / PR, `codeql` weekly scan
- Dependabot for npm and github-actions, weekly cadence

[Unreleased]: https://github.com/Atsumi3/github-pr-dashboard/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Atsumi3/github-pr-dashboard/releases/tag/v1.0.0
