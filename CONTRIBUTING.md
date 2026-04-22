# Contributing Guide

GitHub PR Dashboard は **ローカル単独利用** を目的としています。新機能の提案も「ローカル単独利用で役立つか」を判断軸としてください。

## 行動規範

[Contributor Covenant v2.1](./CODE_OF_CONDUCT.md) を採用しています。

## Issue / Pull Request

- Issue は既存と重複していないか確認の上で。バグ報告は再現手順 + 環境情報を含めてください
- セキュリティ問題は公開 Issue ではなく [SECURITY.md](./SECURITY.md) の手順で
- PR は 1 トピックに絞り、ローカルで `docker compose up` が通ることを確認

## ローカル開発

### 必要要件

- Docker Desktop (Compose v2 以降)
- (任意、開発時のみ) Node.js 20+ / pnpm 9.15.5 (`corepack enable` で導入可)

### セットアップ

```bash
git clone https://github.com/<your-fork>/github-pr-dashboard.git
cd github-pr-dashboard
corepack enable
pnpm install
cp .env.example .env
docker compose up --build
```

ai-server を使う場合は別ターミナルで `cd ai-server && AI_SHARED_SECRET=<.env と同じ値> node server.js`。

### Lint / Format

PR を出す前に必ず実行してエラー 0 にしてください。CI では `pnpm lint` のみ実行します。

```bash
pnpm lint           # ESLint (flat config)
pnpm format:check   # Prettier 差分チェック
pnpm lint:fix       # 自動修正
pnpm format         # Prettier 適用
```

### 自動テスト

現状なし。動作確認は `docker compose up --build` 後にブラウザで手動シナリオ。

## サービス構成

| サービス  | 起動先         | ポート            |
| --------- | -------------- | ----------------- |
| frontend  | Docker (nginx) | `127.0.0.1:3000`  |
| backend   | Docker (Node)  | `3001` (内部のみ) |
| ai-server | ホスト (Node)  | `127.0.0.1:3002`  |

backend → ai-server は `host.docker.internal` 経由、`AI_SHARED_SECRET` で認証。

## ディレクトリ概要

```
backend/src/
  server.js           Express bootstrap + originGuard / authMiddleware
  middleware/auth.js  X-GitHub-Token + token 切替検知
  routes/             REST ハンドラ (auth / repos / prs / settings / ai)
  github.js           GitHub GraphQL/REST ラッパー
  cache.js            PR 一覧キャッシュ
  detailCache.js      PR 詳細キャッシュ (LRU + TTL)
  store.js            data/config.json 永続化
  tokenHash.js        PAT を sha256 でハッシュ化
  httpError.js        sendError + ERROR_CODES
frontend/js/
  app.js              ダッシュボード本体
  settings.js         サイドバー + AI 設定 + toast
  api.js              fetch ラッパー
  token-store.js      localStorage 管理 + SW 同期
  local-cache.js      dash:* localStorage キャッシュ
  sw.js               Service Worker (15 分 TTL)
ai-server/server.js   ホスト常駐 HTTP サーバー (CLI spawn)
```

## コーディング規約

- JS は ES Modules (`import`/`export`)、`const` 優先、async/await
- HTML/CSS は kebab-case、既存デザイントークンを尊重
- 依存パッケージはバージョン完全固定 (`^` / `~` / `latest` 禁止)、公式レジストリのみ
- GitHub Actions は SHA pin + タグコメント併記 (Renovate / Dependabot 連動のため)

## コミットメッセージ

[Conventional Commits](https://www.conventionalcommits.org/) を推奨 (必須ではない)。`feat:` `fix:` `docs:` `refactor:` `chore:` など。
