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

| サービス         | 役割                              | ポート              | ベース            |
| ---------------- | --------------------------------- | ------------------- | ----------------- |
| frontend         | 静的配信 + ServiceWorker          | 127.0.0.1:3000 → 80 | nginx:1.27-alpine |
| backend          | REST API、GitHub 呼び出し、永続化 | 3001 (内部のみ)     | node:22-alpine    |
| ai-server (任意) | ホスト CLI を呼ぶ要約サーバー     | 127.0.0.1:3002      | host node 20+     |

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
4. `setup.html` に遷移

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

- `GET /api/prs?assignee=me` — 全監視 repo の PR をフィルタ済みで一括取得（5 分 cache）
- `GET /api/prs/repo/:owner/:repo?assignee=me` — 単一 repo の PR
- `GET /api/prs/:owner/:repo/:number?noCache=1` — PR 詳細
- `POST /api/prs/refresh?assignee=me` — cache クリアして再取得

ソートはフロント責務。バックエンドはフィルタのみ行い fetch 順で返す。

### 3.5 設定 API

- `GET /api/settings` — `{ pollInterval }`
- `PUT /api/settings` — `pollInterval` (15-3600 秒)

### 3.6 AI 要約 API

- `POST /api/ai/summarize` — `{ text }` を ai-server へ転送
- `POST /api/ai/summarize-pr` — `{ title, body, files }` を転送

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

| 層          | 場所                     | 種類                  | TTL                | 目的                                 |
| ----------- | ------------------------ | --------------------- | ------------------ | ------------------------------------ |
| 全 PR cache | backend `cache.js`       | グローバル            | pollInterval (60s) | poll 同時多発の thundering herd 抑制 |
| 詳細 cache  | backend `detailCache.js` | LRU 200               | pollInterval       | PR 詳細の連打抑制                    |
| meCache     | `routes/prs.js`          | LRU 200 (sha256 hash) | 10 分              | GitHub /user 連打抑制                |
| paneCache   | frontend `app.js`        | LRU 50                | 60 秒              | 詳細ペイン再 open 高速化             |
| SW cache    | frontend `sw.js`         | LRU 50 + TTL ヘッダ   | 5 分               | オフライン耐性                       |

`buildResponse` は `(cache.version, store.reposVersion, me)` でメモ化されている。

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
├── server.js           Express 起動 + ルート登録
├── middleware/
│   └── auth.js         X-GitHub-Token 存在チェック
├── routes/
│   ├── auth.js         GET /api/auth/me
│   ├── repos.js        リポジトリ管理 + 提案/検索
│   ├── prs.js          PR 一覧/詳細/refresh
│   ├── settings.js     pollInterval
│   └── ai.js           ai-server プロキシ
├── github.js           GitHub API クライアント (GraphQL + REST)
├── store.js            config.json 読み書き + reposVersion
├── cache.js            全 PR cache + version counter
├── detailCache.js      LRU 詳細 cache
├── repoId.js           owner/name 検証共通化
└── httpError.js        sendError + ERROR_CODES
```

### 6.2 GitHub API

GraphQL 一発で 50 PR + reviews + commits + labels を取得 (`OPEN_PRS_QUERY`)。詳細は REST `/pulls/:n` + `/files` + GraphQL `reviewThreads` を `Promise.all` で並列。

`gqlWithRetry` が 5xx で 1 回リトライ + 30 秒タイムアウト。

### 6.3 inflightFetchAll の集約

`fetchAllPRs(token)` 同時呼び出しは Promise を共有。**注意**: シングルテナント前提。マルチテナント運用には分割が必要 (ソース内コメント参照)。

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
├── docker-entrypoint.sh は廃止 (config.js 注入が不要に)
├── css/style.css       パステルテーマ + レスポンシブ
└── js/
    ├── api.js          fetch ラッパ + token re-export
    ├── token-store.js  localStorage + SW 同期
    ├── sw.js           ServiceWorker (TTL cache + LOGOUT_REQUIRED)
    ├── sw-register.js  scope:'/' で登録 + メッセージ受信
    ├── app.js          ダッシュボード本体
    └── settings.js     サイドバー UI
```

### 7.2 ServiceWorker

- スコープ: `/` (registerオプションと `Service-Worker-Allowed: /` の両方必須)
- `/api/*` のみ intercept
- GET 成功レスポンスに `x-sw-cached-at` ヘッダ付与で TTL 5 分
- maxEntries 50 (10 put ごとに trim)
- 401 検知 → `caches.delete(API_CACHE)` + `LOGOUT_REQUIRED` 配信

### 7.3 ポーリング

`startPolling` は `pollingCallId` で並行起動を guard。
`visibilitychange` で停止/再開。
hidden 時は `updateLastUpdatedDisplay` の 1 秒タイマーも停止。

### 7.4 検索 / ソート

- 検索: 200ms debounce、`applySearchFilter` を再描画後にも `reapplySearchFilter` で再適用
- ソート: `lastData` をモジュール変数に保持し、変更時は `rerenderFromLastData` で fetch 不要

## 8. Docker Compose 設計

### 8.1 docker-compose.yml

backend は `expose:3001` で内部のみ。frontend が `127.0.0.1:3000:80` で公開。`extra_hosts: host.docker.internal:host-gateway` で backend → ai-server 接続。

### 8.2 環境変数

| 変数               | 必須          | 説明                           |
| ------------------ | ------------- | ------------------------------ |
| `AI_SHARED_SECRET` | AI 要約使用時 | ai-server との共有シークレット |

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
