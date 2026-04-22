# 設計仕様書: GitHub PR Dashboard (PAT モード)

> 旧設計 (Firebase Auth + firebase-admin) の記述は [design-historical.md](./design-historical.md) を参照。本ドキュメントは現行 PAT 専用構成を反映しています。

## 1. システムアーキテクチャ

### 1.1 全体構成

```
┌─────────────────────────────────────────────────────────┐
│ Docker Compose                                          │
│                                                         │
│  ┌──────────────┐       ┌───────────────────────────┐   │
│  │   frontend   │       │         backend           │   │
│  │   (nginx)    │──────→│      (Node.js/Express)    │   │
│  │  127.0.0.1   │       │   :3001  (internal only)  │   │
│  │  :3000 → :80 │       └──────────┬────────────────┘   │
│  └──────────────┘                  │                    │
│                              ┌─────▼─────┐              │
│                              │ data vol  │              │
│                              │config.json│              │
│                              └───────────┘              │
└────────────────────────────────────┬────────────────────┘
                                     │ GitHub GraphQL/REST
                                     ▼
                             ┌───────────────┐
                             │  GitHub API   │
                             └───────────────┘

       (任意)
       ┌────────────────┐
       │  ai-server     │ ← backend からホスト経由
       │  (Node.js)     │   (claude / codex / gemini)
       │ 127.0.0.1:3002 │
       └────────────────┘
```

### 1.2 サービス構成

| サービス         | 役割                                                                                                         | ポート              | ベース            |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ------------------- | ----------------- |
| frontend         | 静的配信 + ServiceWorker                                                                                     | 127.0.0.1:3000 → 80 | nginx:1.27-alpine |
| backend          | REST API、GitHub 呼び出し、永続化                                                                            | 3001 (内部のみ)     | node:22-alpine    |
| ai-server (任意) | ホスト CLI を spawn (claude/codex/gemini/chatgpt の whitelist のみ)、`AI_SHARED_SECRET` 認証、Host whitelist | 127.0.0.1:3002      | host node 20+     |

## 2. 認証設計

### 2.1 認証モデル

PAT 専用。ユーザーがブラウザのセットアップ画面で GitHub Personal Access Token を入力し、`localStorage` に平文保存する。バックエンドは token を**ディスクに永続化しない**。

### 2.2 リクエストフロー

```
ブラウザ ──[ X-GitHub-Token: ghp_... ]──→ backend ──[ Authorization: token ghp_... ]──→ GitHub API
                  ↑                            │
                  │                       (req.token に格納)
            localStorage                       │
            または ServiceWorker      ←──── 401 検知時に
                                               WORKAROUND を返す
```

frontend は次の 2 経路で `X-GitHub-Token` を付与する。

1. `api.js` が `request()` 内で同期的に `getToken()` → header set
2. ServiceWorker (`sw.js`) が intercept してフォールバックで付与 (二重防御)

### 2.3 バックエンド側の検証

`backend/src/middleware/auth.js` は **token の存在チェックのみ** 行う。GitHub への問い合わせで実際の検証が起きる。意図的な単純設計：

- ローカル単独利用が前提なので、追加の検証層は ROI が低い
- 不正 token は即座に GitHub から 401 が返り、フロントが setup.html へ戻す

### 2.4 ログアウトフロー

1. UI のログアウトボタン → `clearStoredToken()`
2. `localStorage.removeItem('gh-token')`
3. ServiceWorker に `CLEAR_CACHE` メッセージ → API キャッシュ削除
4. localStorage の `dash:*` (me / repos / prs / ai 要約) も `clearAllCaches()` で全削除
5. `setup.html` に遷移

### 2.5 token 切替検知

backend の `authMiddleware` は受信した token の sha256 ハッシュを保持し、ハッシュが直前のリクエストと変わったら自動で `cache.clear()` / `detailCache.clear()` を実行する。これは別 GitHub アカウントでログインし直したとき、前ユーザーの private リポジトリのデータが新セッションに混入しないための保険層。`tokenHash.js` ヘルパーで生 PAT を長く保持しないようにしている。

frontend 側は `token-store.js` の `setToken` が旧 token と異なる場合に SW へ `CLEAR_CACHE` を送信し、SW キャッシュも連動して破棄される。

### 2.6 Origin / Referer ガード

`backend/src/server.js` の `originGuard` ミドルウェアが `ALLOWED_ORIGINS` (デフォルト `http://localhost:3000,http://127.0.0.1:3000`) と Origin / Referer ヘッダを照合し、許可外なら 403。`/api/health` のみ除外。Origin も Referer も無いリクエスト (CLI / SSR / SW) は token チェックに任せて通過させる。

## 3. API 設計

### 3.1 エラーレスポンス共通フォーマット

```json
{ "error": { "code": "ERROR_CODE", "message": "...日本語または英語..." } }
```

`code` は `backend/src/httpError.js` の `ERROR_CODES` 定数で集中管理：
`INVALID_REQUEST` / `INVALID_TOKEN` / `REPO_NOT_FOUND` / `REPO_ALREADY_EXISTS` /
`GITHUB_TOKEN_EXPIRED` / `RATE_LIMITED` / `INTERNAL_ERROR` /
`AI_SERVER_ERROR` / `AI_SERVER_UNAVAILABLE`

ヘルパ `sendError(res, status, code, message)` 経由で全 route が出力する。

### 3.2 認証 API

- `GET /api/auth/me` — `X-GitHub-Token` で GitHub /user を叩き `{ user: { login, avatarUrl } }` を返す。401 時は `GITHUB_TOKEN_EXPIRED`

### 3.3 リポジトリ管理 API

- `GET /api/repos` — 監視中リポ一覧
- `POST /api/repos` — `{ repo: "owner/name" }`、検証後追加。重複は 409
- `PATCH /api/repos/:owner/:name` — `{ paused: bool }`
- `DELETE /api/repos/:owner/:name` — 削除
- `GET /api/repos/suggestions` — GitHub Search で自分関連 PR を持つ repo を提案
- `GET /api/repos/search?q=...` — リポジトリ検索

### 3.4 PR API

- `GET /api/prs?assignee=me` — 全監視 repo の PR をフィルタ済みで一括取得 (TTL = pollInterval)
- `GET /api/prs/repo/:owner/:repo?assignee=me` — 単一 repo の PR
- `GET /api/prs/:owner/:repo/:number?noCache=1` — PR 詳細
- `POST /api/prs/refresh?assignee=me` — cache クリアして再取得 (inflight があっても force で奪取)

ソートはフロント責務。バックエンドはフィルタのみ行い fetch 順で返す。

PR 詳細レスポンスには以下のフィールドが含まれる。

| フィールド               | 説明                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unresolvedThreads`      | GraphQL `reviewThreads` から `isResolved=false && isOutdated=false` のみ抽出                                                                                                |
| `unresolvedThreadsError` | 上記取得が失敗したときのみエラーメッセージ                                                                                                                                  |
| `failedChecks`           | `statusCheckRollup` から失敗扱い (FAILURE/TIMED_OUT/CANCELLED/ACTION_REQUIRED/STARTUP_FAILURE) のみ抽出。各エントリに `name` / `conclusion` / `url` (Actions ログ等) を含む |
| `checksRollupState`      | rollup 全体の状態 (SUCCESS / FAILURE / PENDING など)                                                                                                                        |
| `failedChecksError`      | checks 取得失敗時のエラーメッセージ                                                                                                                                         |
| `behindBy` / `aheadBy`   | REST `/compare` から取得                                                                                                                                                    |

`detailCache` は `unresolvedThreadsError` または `failedChecksError` がセットされている partial-failure では cache せず、次回 GitHub が回復した時にすぐ取り直す。

### 3.5 設定 API

- `GET /api/settings` — `{ pollInterval }`
- `PUT /api/settings` — `pollInterval` (15-3600 秒)

### 3.6 AI 要約 API

- `POST /api/ai/summarize` — `{ text }` を ai-server へ転送
- `POST /api/ai/summarize-pr` — `{ title, body, files }` を転送
- `GET /api/ai/status` — ai-server の `/status` を中継 (利用可能 CLI、現プロンプトなど)
- `PUT /api/ai/config` — `{ cli?, prompts? }` を ai-server に転送。`prompts` を含む更新は `X-Confirm-Ai-Config: 1` ヘッダ必須 (CSRF/XSS 経由のプロンプト改ざん緩和)

ai-server が落ちている場合は 503 + `AI_SERVER_UNAVAILABLE`。

## 4. データ永続化

### 4.1 config.json

```json
{
  "repos": [{ "id": "owner/name", "addedAt": "ISO8601", "paused": false }],
  "settings": { "pollInterval": 60 }
}
```

token は **保存しない**。

### 4.2 キャッシュ

| 層            | 場所                      | 種類                  | TTL                             | 目的                                 |
| ------------- | ------------------------- | --------------------- | ------------------------------- | ------------------------------------ |
| 全 PR cache   | backend `cache.js`        | グローバル            | pollInterval (デフォルト 60s)   | poll 同時多発の thundering herd 抑制 |
| 詳細 cache    | backend `detailCache.js`  | LRU 200               | pollInterval                    | PR 詳細の連打抑制                    |
| meCache       | `routes/prs.js`           | LRU 200 (sha256 hash) | 10 分                           | GitHub /user 連打抑制                |
| paneCache     | frontend `app.js`         | LRU 50                | 60 秒                           | 詳細ペイン再 open 高速化             |
| SW cache      | frontend `sw.js`          | LRU 50 + TTL ヘッダ   | 15 分 (`local-cache.js` と一致) | ネットワーク失敗時のフォールバック   |
| localStorage  | frontend `local-cache.js` | `dash:me/repos/prs`   | me/repos = 1h、prs = 15 分      | ハードリロード後の即時再描画         |
| AI 要約 cache | frontend `local-cache.js` | `dash:ai:*`           | 7 日                            | 同一 PR 詳細を再開時に再要約しない   |

`buildResponse` は `(cache.version, store.reposVersion, me)` でメモ化されている。`paused` の repo は `prs: []` に強制上書きしてから返すため、UI と stats は polling とは独立に即時反映される。

## 5. 画面設計

### 5.1 画面遷移

```
setup.html ─[PAT 入力 + 検証]─→ index.html
       ↑                            │
       └──[401 / logout]──────────────┘
```

### 5.2 主要画面

- **setup.html**: PAT 入力フォームのみ
- **index.html**: 左サイドバー (リポ管理) + 中央 (PR グリッド) + 詳細ペイン (右スライドイン)

### 5.3 配色

パステル調 + ステータス別カード色分け。トークン定義は `frontend/css/style.css` の `:root` 参照。`--status-changes` (coral) / `--status-pending` (peach) / `--status-approved` (mint) など。

### 5.4 レスポンシブ

`@media` ブレークポイント: 600 / 900 / 1280 / 2560 / 3840px。グリッドカラム数を画面幅に応じ動的に切替。

## 6. バックエンド設計

### 6.1 ディレクトリ構成

```
backend/src/
├── server.js           Express 起動 + originGuard / authMiddleware の組み立て
├── middleware/
│   └── auth.js         X-GitHub-Token 存在チェック + token 切替検知 → cache クリア
├── routes/
│   ├── auth.js         GET /api/auth/me
│   ├── repos.js        リポジトリ管理 + 提案/検索
│   ├── prs.js          PR 一覧/詳細/refresh
│   ├── settings.js     pollInterval
│   └── ai.js           ai-server プロキシ + X-Confirm-Ai-Config 検証
├── github.js           GitHub API クライアント (GraphQL + REST)
├── store.js            config.json 読み書き + reposVersion
├── cache.js            全 PR cache + version counter
├── detailCache.js      LRU 詳細 cache
├── tokenHash.js        PAT を sha256 でハッシュ化 (キャッシュキー / 切替検知用)
├── repoId.js           owner/name 検証共通化
└── httpError.js        sendError + ERROR_CODES + mapGithubError
```

### 6.2 GitHub API と PR fetch 戦略

PR 一覧は 2 経路。

- **`assignee=me` 経路**: `searchOpenPRsForMe` が GraphQL search を 5 リポジトリずつチャンクし、`involves:USER` と `review-requested:USER` の 2 クエリを並列実行 (`SEARCH_PRS_QUERY`)。N リポジトリ分を ~ceil(N/5)\*2 クエリに集約しサーバ側でフィルタ完結
- **未指定経路 / search 失敗時のフォールバック**: 旧来通り repo 単位の `OPEN_PRS_QUERY` を `Promise.all` で並列実行 (`fetchPerRepo`)

PR 詳細は REST `/pulls/:n` + `/files` + GraphQL `reviewThreads` (未解決コメント) + GraphQL `statusCheckRollup` (失敗 CI) を `Promise.all` で並列。各サブ取得は失敗しても他をブロックせず、それぞれの `*Error` フィールドで部分失敗を通知する (`detailCache` は partial-failure 時は cache しない)。

`gqlWithRetry` は 15 秒/試行 × 3 回 + 1s/2s バックオフ (合計最大 ~48 秒)。

### 6.3 inflightFetchAll の集約と force 上書き

`fetchAllPRs(token, me, { force })` は同時呼び出しを Promise で共有 (thundering herd 抑制)。`/api/prs/refresh` は `force: true` を渡し、inflight 中の Promise を破棄して新しい fetch を走らせる (refresh の意味を保つ)。**シングルテナント前提**で token 別の partition はしていない (ソース内コメント参照)。

partial failure ハンドリング: `cache.peek()` で TTL 無視の前回スナップショットを取り、各 repo の fetch 失敗時は前回データを carry-over。全 repo 失敗のときは cache を更新せず前回スナップショットを維持。

### 6.4 エラーハンドリング

GitHub の `401/403` を `mapGithubError` で `GITHUB_TOKEN_EXPIRED` / `RATE_LIMITED` に正規化。それ以外は `INTERNAL_ERROR`。

### 6.5 ヘルスチェック

`GET /api/health` → `{status: 'ok'}`。docker compose の healthcheck に使用。

## 7. フロントエンド設計

### 7.1 ディレクトリ構成

```
frontend/
├── index.html          ダッシュボード
├── setup.html          PAT 入力
├── nginx.conf          + security-headers.conf (include)
├── css/style.css       パステルテーマ + レスポンシブ
└── js/
    ├── api.js          fetch ラッパ (X-GitHub-Token / X-Confirm-Ai-Config 付与)
    ├── token-store.js  localStorage + SW 同期 + 旧 token と異なれば SW CLEAR
    ├── local-cache.js  dash:me/repos/prs/ai:* の永続キャッシュ
    ├── sw.js           ServiceWorker (TTL 15min cache + LOGOUT_REQUIRED)
    ├── sw-register.js  scope:'/' で登録 + メッセージ受信
    ├── app.js          ダッシュボード本体
    └── settings.js     サイドバー UI + AI 設定 + toast 集約
```

### 7.2 ServiceWorker

- スコープ: `/` (register オプションと `Service-Worker-Allowed: /` の両方必須)
- `/api/*` のみ intercept
- GET 成功レスポンスに `x-sw-cached-at` ヘッダ付与で TTL 15 分 (`local-cache.js` の PRS_TTL と一致)
- maxEntries 50 (10 put ごとに trim)
- 401 検知 → `caches.delete(API_CACHE)` + `LOGOUT_REQUIRED` 配信
- `CACHE_VERSION = 'v3'` (バンプすると activate で旧キャッシュを掃除)
- nginx 側で `index.html` / `*.js` / `*.css` に `Cache-Control: no-cache` を付与しているため、ブラウザ HTTP キャッシュで古い app.js が走るリスクはない

### 7.3 ポーリング

`startPolling({ skipImmediate, intervalMs })` は `pollingCallId` で並行起動を guard。

- フォアグラウンド: ユーザー設定の `pollInterval` (15-3600 秒)
- バックグラウンド (`document.hidden`): 5 分固定 (`BACKGROUND_POLL_MS`) — 完全停止せず低頻度で回し続けることで `detectChangesAndNotify` の native 通知が継続発火する
- フォアグラウンド復帰時に最終 fetch から 30 秒 (`VISIBILITY_REFETCH_THRESHOLD`) 以内なら即時 fetch をスキップ

`updateLastUpdatedDisplay` の 1 秒タイマーは hidden 時に停止 (画面に出ていないので無駄)。

### 7.4 表示 / ポーリングフラグの統合

backend の `paused` フラグが UI 可視性とポーリング停止の **唯一の真実源**。サイドバーの目アイコン 1 つで両方を atomic に切替える (旧 `pr-dashboard-hidden-repos` localStorage は廃止、init で 1 回 cleanup)。

- backend は `activeRepos = !r.paused` で fetch 自体をスキップ → API レート消費ゼロ
- `buildResponse` は paused repo を `prs: []` に強制
- frontend の `reconcileRepoSections` は paused repo の section を作らない
- `isRepoActive(repoId)` は `lastData` の `paused` を見るローカルヘルパー

### 7.5 検索 / ソート

- 検索: 200ms debounce、`applySearchFilter` を再描画後にも `reapplySearchFilter` で再適用。全件除外時は "No PRs match" の空状態を表示
- ソート: `lastData` をモジュール変数に保持し、変更時は `rerenderFromLastData` で fetch 不要。スクロール位置は `requestAnimationFrame` で復元
- Load more: 追加分の先頭カードへ `focus()` を移譲 (キーボード操作時のフォーカス喪失防止)

## 8. Docker Compose 設計

### 8.1 docker-compose.yml

backend は `expose:3001` で内部のみ。frontend が `127.0.0.1:3000:80` で公開。`extra_hosts: host.docker.internal:host-gateway` で backend → ai-server 接続。

### 8.2 環境変数

| 変数                | 必須          | 説明                                                                                         |
| ------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| `AI_SHARED_SECRET`  | AI 要約使用時 | ai-server との共有シークレット (ai-server 側は未設定なら起動拒否)                            |
| `HOST_AI_URL`       | 任意          | backend が呼び出す ai-server の URL (デフォルト `http://host.docker.internal:3002`)          |
| `ALLOWED_ORIGINS`   | 任意          | Origin / Referer ガード許可リスト (デフォルト `http://localhost:3000,http://127.0.0.1:3000`) |
| `AI_REQUIRE_SECRET` | 任意          | ai-server 側、`0` で `AI_SHARED_SECRET` 未設定でも起動 (非推奨)                              |
| `AI_CONFIG_PATH`    | 任意          | ai-server 側、ランタイム設定の永続化先 (デフォルト `./ai-config.json`)                       |

### 8.3 Dockerfile

- backend: node:22-alpine + corepack 同梱版で pnpm 9.15.5 (packageManager 固定)
- frontend: nginx:1.27-alpine、entrypoint なし

### 8.4 サプライチェーン

- pnpm lockfile を `frozen-lockfile` でインストール
- `npm install -g latest` を使わない
- pnpm バージョンは `package.json` の `packageManager` フィールドで固定

## 9. PAT スコープ

| スコープ      | 用途                                          |
| ------------- | --------------------------------------------- |
| `repo`        | private リポジトリ含む                        |
| `public_repo` | public リポジトリのみ                         |
| `read:org`    | 組織メンバーの PR を取得 (suggestions に必要) |

## 10. セキュリティ方針

詳細は [SECURITY.md](../SECURITY.md) 参照。要点：

- ローカル単独利用が前提
- token は localStorage に平文保存（XSS リスク許容）
- nginx CSP は `default-src 'self'`、frame-ancestors 'none'
- ai-server は Host ヘッダ allowlist で DNS rebinding 緩和

## 11. 技術スタック

- バックエンド: Node.js 22 + Express 4.21.2 (依存はこれのみ)
- フロントエンド: Vanilla HTML/CSS/JS (依存ゼロ、CDN 経由 Web Font のみ)
- 配信: nginx 1.27
- ai-server: Node.js 20+ + node:child_process (依存ゼロ)
