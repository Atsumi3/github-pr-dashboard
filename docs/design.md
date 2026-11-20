# 設計仕様書

GitHub PR Dashboard (PAT モード) の設計概要。実装の正は各ソースファイル。

## 1. アーキテクチャ

```
┌─────────────────────────────────────────┐
│ Docker Compose                          │
│  ┌──────────┐   ┌──────────────────┐    │
│  │ frontend │──→│ backend (Express)│    │
│  │ (nginx)  │   │ :3001 内部のみ    │    │
│  │ :3000    │   └──────┬───────────┘    │
│  └──────────┘          │                │
│                  ┌─────▼──────┐         │
│                  │ data vol   │         │
│                  └────────────┘         │
└──────────────────────┬──────────────────┘
                       │ GitHub GraphQL/REST
                       ▼
                ┌──────────────┐
                │  GitHub API  │
                └──────────────┘

       (任意、ホスト常駐)
       ┌────────────────┐
       │  ai-server     │ ← backend からホスト経由
       │  127.0.0.1:3002│   AI_SHARED_SECRET 認証
       └────────────────┘
```

| サービス  | 役割                                 | ポート          | ベース            |
| --------- | ------------------------------------ | --------------- | ----------------- |
| frontend  | 静的配信 + Service Worker            | 127.0.0.1:3000  | nginx:1.29-alpine |
| backend   | REST API、GitHub 呼び出し、永続化    | 3001 (内部のみ) | node:24-alpine    |
| ai-server | ホスト CLI を spawn する要約サーバー | 127.0.0.1:3002  | host node 20+     |

## 2. 認証

- ユーザーが PAT を `localStorage` に保存。バックエンドはディスク永続化しない
- frontend は `X-GitHub-Token` ヘッダで都度送信
- backend `authMiddleware` はヘッダ存在チェックのみ。GitHub への問い合わせで実検証
- **token 切替検知**: backend は `tokenHash.js` で sha256 を保持し、ハッシュが変わったら `cache.clear()` / `detailCache.clear()` を自動実行 (別 GitHub アカウントのデータ混入防止)
- **Origin / Referer ガード**: `ALLOWED_ORIGINS` (デフォルト `http://localhost:3000,http://127.0.0.1:3000`) と照合、許可外は 403。`/api/health` のみ除外
- **ログアウト**: `clearStoredToken()` → `localStorage.removeItem` + `clearAllCaches()` + Service Worker `CLEAR_CACHE` 送信
- frontend のレビュー tracker は GitHub login 単位で保存し、token 切替・ログアウトで消去する。token 自体は tracker に保存しない

## 3. PR 取得戦略

| 経路           | 条件                         | 仕組み                                                                                                         |
| -------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GraphQL search | `assignee=me` 指定時         | `involves:USER` + `review-requested:USER` を 5 リポジトリ単位でチャンク並列。N 個を ~ceil(N/5)\*2 クエリに集約 |
| per-repo fetch | 上記未指定時 / search 失敗時 | 旧来通り `OPEN_PRS_QUERY` を repo 単位で並列                                                                   |

PR 詳細は REST `/pulls/:n` + `/files` + GraphQL `reviewThreads` (未解決コメント) + GraphQL `statusCheckRollup` (失敗 CI) を `Promise.all` で並列。

両方の一覧クエリは `reviews(last: 50, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED])` を取得する。各 PR あたり直近 50 件の送信済みレビューを `reviewEvents` として返し、status chip 用の `latestOpinionatedReviews` は維持する。追加の PR ごとの問い合わせは行わない。レビュー本文・単独の会話コメント・レビュー thread の返信は通知対象外。

partial failure ハンドリング:

- 各 repo の失敗時は `cache.peek()` で前回スナップショットを carry-over
- 全 repo 失敗時は cache を更新せず維持
- PR 詳細は `unresolvedThreadsError` / `failedChecksError` がセットされている partial-failure では cache しない

## 4. キャッシュ層

| 層             | 場所                         | TTL                                                                  | 目的                                          |
| -------------- | ---------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| backend cache  | `backend/src/cache.js`       | pollInterval (デフォルト 60s)                                        | thundering herd 抑制                          |
| backend detail | `backend/src/detailCache.js` | pollInterval                                                         | PR 詳細の連打抑制                             |
| meCache        | `routes/prs.js`              | 10 分 (sha256 hash)                                                  | GitHub /user 連打抑制                         |
| Service Worker | `frontend/js/sw.js`          | 15 分                                                                | ネットワーク失敗時のフォールバック            |
| localStorage   | `frontend/js/local-cache.js` | me/repos = 1h、prs = 15min、review tracker = 期限なし (件数上限あり) | ハードリロード後の即時再描画 / 未読状態の復元 |
| AI 要約        | `dash:ai:*`                  | 7 日                                                                 | 同一 PR 詳細の再要約抑制                      |

paused リポジトリは `buildResponse` で `prs: []` に強制上書きされ、UI は polling とは独立に即時反映される。`/api/prs/refresh` は `force: true` で inflight Promise を奪取。

## 5. ポーリング / 表示の統合

- フォアグラウンド / バックグラウンド (`document.hidden`): どちらもユーザー設定の `pollInterval` (15-3600s、既定 60s)
- フォアグラウンド復帰時に最終 fetch から 30 秒以内なら即時 fetch をスキップ
- ブラウザが非表示タブの timer を遅延・停止した場合は検出も遅れる。ページを閉じている間は通知されない (Web Push / 常駐 daemon は未実装)

## 5.1 新着レビュー通知

- 認証ユーザーと `owner/repo#number` ごとにレビュー ID を追跡し、初回観測は通知せず履歴を基準化する。以後は未観測の送信済みレビュー ID を検出し、同じ集約 status のままのレビューや COMMENTED / Bot のレビューも未読にする。
- 直近 50 件の GraphQL 一覧窓を走査し、`submittedAt` と ID を watermark / seen set とともに bounded localStorage に保存する（PR は最大 500 件、各 PR の seen ID と watermark ID は各 100 件、既読 acknowledgement ID は各 500 件、未読レビューは全体で 250 件まで）。storage event と次の tracker 更新でタブ間の状態を ID 単位に統合する。既読 acknowledgement の保持上限を超えた履歴を持つ停止中タブとの同期は best effort である。この追加は既存クエリ内で完結しリクエスト数は増やさないが、PR ごとに最大 50 件分だけを対象とするため、それを超える取得窓の外のレビューは検出を保証しない。失敗・pause・一時的な一覧欠落・順序逆転では未読を消さず、キャッシュ描画は通知を発生させない。
- PR ごとの `N new reviews` リンクまたはブラウザ通知を選ぶと、操作時点で把握済みの未読 ID だけを既読にし、最新レビュー URL (取得不可なら PR URL) を開く。詳細ペインを開くだけでは既読にしない。
- Browser notifications の許可要求はサイドバーの `Enable notifications` 操作後のみ。拒否・未対応でもカードバッジとアプリ内通知は使える。通知は PR ごとにまとめる。
- 対象は PR の送信済み review event。単独の会話コメントと review thread の返信は対象外。閉じたブラウザへの配信には Web Push または daemon が別途必要。

backend の `paused` フラグが UI 可視性とポーリング停止の **唯一の真実源**。サイドバーの目アイコン 1 つで両方を atomic に切替える。

## 6. AI 要約 (任意)

- frontend → backend `/api/ai/*` → ai-server (host) を `AI_SHARED_SECRET` で認証
- ai-server は `claude` / `codex` / `gemini` / `chatgpt` の whitelist のみ実行可
- プロンプト更新は `X-Confirm-Ai-Config: 1` ヘッダ必須 (XSS 経由のプロンプト改ざん緩和)
- `<<<USER_DATA_START>>>` / `<<<USER_DATA_END>>>` フェンスで間接プロンプトインジェクション緩和
- UI は「LLM による要約。重要な判断の前に必ず原文を確認してください。」disclaimer を常時表示

詳細: [ai-server/README.md](../ai-server/README.md)

## 7. セキュリティ

詳細は [SECURITY.md](../SECURITY.md)。要点:

- ローカル単独利用前提
- PAT は localStorage 平文保存 (XSS リスク許容、fine-grained PAT + 最小スコープ推奨)
- backend Origin/Referer ガード + token 切替時自動 cache クリア
- AI server: shared secret 必須 (FATAL gate)、Host whitelist (DNS rebinding 緩和)、CLI whitelist
- CSP: `script-src 'self'` 厳格化、`style-src 'unsafe-inline'` は動的色のため残存
- クライアント返却エラーは固定文言。詳細は console.error のみ
- nginx は `index.html` / `*.js` / `*.css` に `Cache-Control: no-cache`

## 8. 技術スタック

- backend: Node.js 24 + Express 5.3.0 (ランタイム依存はこれのみ)
- frontend: Vanilla HTML/CSS/JS (依存ゼロ、CDN 経由 Web Font のみ)
- 配信: nginx 1.29
- ai-server: Node.js 20+ + node:child_process (依存ゼロ、ホスト上)
- 開発: ESLint 10 (flat config) + Prettier、`pnpm@9.15.5`
