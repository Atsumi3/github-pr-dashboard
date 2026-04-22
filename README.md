# GitHub PR Dashboard

[![lint](https://github.com/Atsumi3/github-pr-dashboard/actions/workflows/lint.yml/badge.svg)](https://github.com/Atsumi3/github-pr-dashboard/actions/workflows/lint.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A local single-user PR monitoring dashboard for GitHub. Watch multiple repositories' open PRs at a glance.

> WARNING: This tool is for **local single-user use only**. Do not expose to the public internet or shared networks.

---

## このツールについて

GitHub PR Dashboard は、複数の GitHub リポジトリにまたがる Open な Pull Request を一画面で把握するためのローカル専用ダッシュボードです。
Docker Compose で `docker compose up` するだけで起動でき、ブラウザから設定・操作のすべてを完結できます。

レビュー待ち / アサイン状況 / 未解決コメントなどを横断的に追えるため、「自分のレビュー漏れを防ぎたい」「チームの PR 状況を素早く確認したい」といった用途に向いています。

## 重要な警告

このツールは **ローカル環境で単独ユーザーが利用すること** を前提に設計されています。

- インターネット / 社内ネットワークに公開しないでください
- 共有マシンで複数ユーザーが利用する用途は想定していません
- GitHub access token はブラウザの **localStorage に平文保存** されます (バックエンドはディスク永続化しません)
- バックエンドは `X-GitHub-Token` ヘッダの存在チェックのみで、token の正当性検証は GitHub 側に委ねています
- フロントエンドは `127.0.0.1` への公開のみを想定しています

公開や共有用途に使うと、GitHub アカウントの乗っ取りや情報漏洩のリスクがあります。
詳細は [SECURITY.md](./SECURITY.md) を参照してください。

## 主な機能

- Open PR をリポジトリ別にカード表示 (4 列グリッド、パステル配色)
- ステータス別のカード色分け (Approved / Changes Requested / Pending / Review Required)
- Reviewed / Re-review タグの表示
- CI ステータスバッジ、コンフリクト警告、behind by N の表示
- 古い PR の警告 (7 日 / 14 日経過で段階的に強調)
- 詳細ペイン: 変更ファイル、未解決コメント、失敗した CI チェック (Actions ログへリンク)、AI 要約 (claude / codex / gemini / chatgpt CLI、原文確認の disclaimer 付き)
- ブラウザ通知 (新規 PR 検知 / ステータス変更検知)
- フォアグラウンドはユーザー設定の間隔でポーリング、タブが非表示になっても 5 分間隔のバックグラウンドポーリングを継続して新着通知
- PR タイトル・ブランチ・作成者で検索
- 目アイコンひとつで「表示 + 更新」をまとめてオン/オフ (バックエンドの `paused` フラグが唯一の真実源、停止中はサーバ側の API 呼び出しもゼロ)
- 3 層キャッシュ (バックエンドメモリ / Service Worker 15 分 / localStorage) でハードリロード後も即時再描画
- assignee=me 経路は GitHub GraphQL search で server-side filter (N リポジトリを ~ceil(N/5)\*2 クエリに集約)
- レスポンシブ対応 + 4K 解像度向けスケーリング

## スクリーンショット

|                                               |                                            |
| --------------------------------------------- | ------------------------------------------ |
| ![Desktop](docs/screenshots/desktop-1440.png) | ![Setup](docs/screenshots/setup.png)       |
| デスクトップ (1440px)                         | 初回セットアップ画面                       |
| ![Tablet](docs/screenshots/tablet-900.png)    | ![Mobile](docs/screenshots/mobile-390.png) |
| タブレット (900px)                            | モバイル (390px)                           |

## アーキテクチャ

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
                             │ api.github.com│
                             └───────────────┘

       (任意)
       ┌────────────────┐
       │  ai-server     │ ← backend からホスト経由で呼び出し
       │  (Node.js)     │   (claude / codex / gemini など)
       │ 127.0.0.1:3002 │
       └────────────────┘
```

| サービス         | 役割                                        | ポート              | ベースイメージ     |
| ---------------- | ------------------------------------------- | ------------------- | ------------------ |
| frontend         | 静的ファイル配信 (HTML/CSS/JS)              | 127.0.0.1:3000 → 80 | nginx:alpine       |
| backend          | REST API, GitHub API 呼び出し, データ永続化 | 3001 (内部のみ)     | node:20-alpine     |
| ai-server (任意) | ホスト上の AI CLI を呼び出して要約を返す    | 127.0.0.1:3002      | ホスト Node.js 20+ |

詳細な設計は [docs/design.md](./docs/design.md) を参照してください。

## 必要要件

- Docker Desktop (Compose v2 以降) — backend / frontend は Docker 経由で動作するため、ホストに Node.js は不要
- (任意) Node.js 20 以上 — AI 要約サーバーをホストで動かす場合 / `pnpm lint` などの開発ツールを使う場合
- (任意) pnpm 9.15.5 (`corepack enable` で導入推奨) — 開発時のみ
- GitHub Personal Access Token (`repo` または `public_repo`、必要に応じて `read:org`)

## セットアップ手順

### 1. リポジトリを取得

```bash
git clone https://github.com/Atsumi3/github-pr-dashboard.git
cd github-pr-dashboard
```

### 2. 環境変数ファイルを準備

```bash
cp .env.example .env
```

AI 要約機能を使わない場合は `.env` を空のままで構いません。

### 3. PAT を生成

1. GitHub Settings → Developer settings → Personal access tokens (classic)
2. 用途に応じてスコープを付与
   - private リポジトリも対象に含める場合: `repo`
   - public リポジトリのみで使う場合: `public_repo`
   - 組織の PR (assignee/reviewer 候補に組織メンバーを含める) も拾う場合は `read:org` を併用
3. 表示された token をコピーしてセットアップ画面に貼り付ける

> 注意: token はブラウザの localStorage に平文で保存され、`X-GitHub-Token` ヘッダとして API リクエストに付与されます。XSS / 拡張機能経由で漏洩しうる点に留意してください。バックエンドは token をディスクに永続化しません。

### 4. 起動

```bash
docker compose up --build
```

ブラウザで http://127.0.0.1:3000 を開き、画面の指示に従ってください。

### 5. AI 要約サーバーを使う場合 (任意)

PR 概要やレビューコメントを LLM で要約する機能を使う場合、ホスト上で AI 要約サーバーを別途起動します。
バックエンドコンテナとは共有シークレット (`AI_SHARED_SECRET`) で認証します。

まず安全なシークレットを生成し、`.env` に記入します。

```bash
openssl rand -hex 32
# 例: 4f9c... のような 64 文字の hex 文字列が出力される
```

`.env` の `AI_SHARED_SECRET` と、ai-server 起動時の環境変数の両方に同じ値を入れてください。値が一致しないと AI 要約 API は 401 を返します。

> **`AI_SHARED_SECRET` 未設定だと ai-server は起動を拒否します (FATAL exit)。**
> 一時的な動作確認のため認証を外したい場合のみ `AI_REQUIRE_SECRET=0` を併用してください。
> その場合は **すべてのリクエストが認証なしで通過し、毎リクエストに `[INSECURE]` 警告がログに残ります**。共有環境では絶対に使わないでください。

```bash
cd ai-server
AI_SHARED_SECRET=<生成した値> node server.js
```

デフォルトでは `claude` CLI を呼び出します。別の CLI (`codex` / `gemini` / `chatgpt` のいずれか) を使うときは環境変数で指定します (許可リストの外は ai-server が拒否します)。

```bash
AI_SHARED_SECRET=<生成した値> AI_CLI=codex node server.js
AI_SHARED_SECRET=<生成した値> AI_CLI=gemini node server.js
```

> AI 要約はユーザーが書いた PR 本文・コメント・ファイル名をそのまま LLM に渡すため、間接プロンプトインジェクションが原理的に起こりえます。要約結果には常に「LLM による要約。重要な判断の前に必ず原文を確認してください。」の disclaimer が表示されますが、要約を信頼境界として扱わないでください。

> AI 設定 API (`PUT /api/ai/config`) でシステムプロンプトを更新する場合は `X-Confirm-Ai-Config: 1` ヘッダが必須です (UI の「保存」ボタン経由は自動で付与されます)。CLI 切り替えなどプロンプト以外の更新には不要です。

詳細は [ai-server/README.md](./ai-server/README.md) を参照してください。

## 環境変数

`.env` で設定する値は以下のとおりです。AI 要約機能を使わない場合は空のままで構いません。

| 変数               | 必須              | 説明                                                |
| ------------------ | ----------------- | --------------------------------------------------- |
| `AI_SHARED_SECRET` | AI 要約を使う場合 | バックエンドと ai-server で共有する認証シークレット |

backend コンテナの環境変数 (`docker-compose.yml` で設定、ほとんどはデフォルトで動きます):

| 変数               | デフォルト                                    | 説明                                                                    |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| `PORT`             | 3001                                          | backend のリスンポート                                                  |
| `HOST_AI_URL`      | `http://host.docker.internal:3002`            | ホスト上の ai-server へのエンドポイント                                 |
| `AI_SHARED_SECRET` | (空)                                          | ai-server と共有する認証シークレット (`.env` から注入)                  |
| `ALLOWED_ORIGINS`  | `http://localhost:3000,http://127.0.0.1:3000` | Origin / Referer ガードの許可リスト (カンマ区切り)。許可外は 403 を返す |

ファイル配置で必要なもの:

| パス               | 必須     | 説明                                                              |
| ------------------ | -------- | ----------------------------------------------------------------- |
| `data/config.json` | 自動生成 | 監視リポジトリ・ポーリング間隔などの永続化先 (token は含まれない) |

ai-server の環境変数:

| 変数                | デフォルト         | 説明                                                                                                |
| ------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `PORT`              | 3002               | リスンするポート                                                                                    |
| `AI_CLI`            | `claude`           | 実行する CLI コマンド名 (許可リスト: `claude` / `codex` / `gemini` / `chatgpt`)                     |
| `AI_CLI_ARGS`       | (空)               | CLI に渡す追加引数 (スペース区切り)。セキュリティ上 API では変更不可、環境変数のみ                  |
| `AI_TIMEOUT_MS`     | 60000              | CLI 実行のタイムアウト (ミリ秒)                                                                     |
| `AI_SHARED_SECRET`  | (空)               | バックエンドとの共有シークレット。未設定だと起動拒否 (`AI_REQUIRE_SECRET=0` でバイパス可だが非推奨) |
| `AI_REQUIRE_SECRET` | (不設定)           | `0` に設定すると `AI_SHARED_SECRET` なしでも起動する (リクエスト毎に `[INSECURE]` 警告ログ)。非推奨 |
| `AI_CONFIG_PATH`    | `./ai-config.json` | ランタイム設定 (選択中 CLI / プロンプト) の永続化先                                                 |

## セキュリティ層 (概要)

詳細は [SECURITY.md](./SECURITY.md) を参照。本リポジトリで実装している主な多層防御:

- `ALLOWED_ORIGINS` ベースの Origin / Referer ガード (許可外は 403)
- `X-GitHub-Token` ヘッダ必須化 + token 切替検知時の自動キャッシュクリア (sha256 ハッシュで照合)
- ai-server 認証: `AI_SHARED_SECRET` 必須、Host ヘッダ whitelist (DNS rebinding 緩和)、CLI 名 whitelist
- AI 設定 API のプロンプト更新は `X-Confirm-Ai-Config: 1` ヘッダ必須 (XSS 経由のプロンプト改ざん緩和)
- LLM 入力は `<<<USER_DATA_START>>>` フェンスでデータ部を明示、要約結果には disclaimer
- クライアントへのエラーメッセージは固定文言 (詳細は console.error のみ)
- CSP は `script-src 'self'` 厳格化 (`style-src 'unsafe-inline'` は動的 style のため当面残存)
- `index.html` / `*.js` / `*.css` は `Cache-Control: no-cache` でハッシュなしでも更新が確実に届く

## ディレクトリ構成

```
.
├── ai-server/        AI 要約サーバー (ホストで実行)
├── backend/          Node.js / Express API サーバー
├── frontend/         nginx 配信の静的フロントエンド
├── data/             永続化データ (gitignore)
├── docs/             設計仕様書 / 要求仕様書 / スクリーンショット
└── docker-compose.yml
```

## トラブルシューティング

| 症状                              | 対処                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 401 が返り続ける                  | localStorage の token が失効している可能性。セットアップ画面に戻り PAT を再入力                                                 |
| GitHub API が rate limit に達する | 設定画面でポーリング間隔を長くする、または余計な監視リポジトリを Pause                                                          |
| AI 要約が動かない                 | ai-server を起動しているか、`AI_SHARED_SECRET` がバックエンドと一致しているか、`AI_CLI` で指定した CLI がパスに通っているか確認 |
| ポート 3000 が使えない            | `docker compose down` 後に `docker-compose.override.yml` を作成し `frontend.ports` を `127.0.0.1:3100:80` などに上書き          |

## ライセンス

[MIT License](./LICENSE)

## コントリビュート

Issue / Pull Request を歓迎します。詳細は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

セキュリティ上の問題は公開 Issue ではなく [SECURITY.md](./SECURITY.md) の手順に従って報告してください。
