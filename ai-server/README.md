# AI Server

ホストで動作する小さな HTTP サーバー。バックエンドコンテナから呼び出され、ホストの CLI (claude / codex / gemini など) を実行して結果を返します。

## 使い方

```bash
cd ai-server
node server.js
```

または別の CLI を使う:

```bash
AI_CLI=codex node server.js
AI_CLI=gemini node server.js
```

## 環境変数

| 変数 | デフォルト | 説明 |
|------|----------|------|
| `PORT` | 3002 | リスンするポート |
| `AI_CLI` | claude | 実行する CLI コマンド |
| `AI_CLI_ARGS` | (空) | CLI に渡す追加引数（スペース区切り） |
| `AI_TIMEOUT_MS` | 60000 | CLI 実行のタイムアウト |
| `AI_SHARED_SECRET` | (空) | バックエンドとの共有シークレット。設定時はリクエストヘッダ `X-AI-Secret` と一致しないと 401 を返す。バックエンド側 (`docker-compose.yml`) と同じ値を設定すること。 |

## エンドポイント

- `GET /health` - ヘルスチェック
- `POST /summarize` - テキスト要約。Body: `{ "text": "..." }` (50KB 上限)
- `POST /summarize-pr` - PR 要約。Body: `{ "title": "...", "body": "...", "files": [{ "filename", "additions", "deletions" }] }` (合算 50KB 上限)

すべてのレスポンスは `{ "summary": "...", "cli": "<cli name>" }` 形式。
`AI_SHARED_SECRET` が設定されていれば `X-AI-Secret` ヘッダ必須。
Host ヘッダは `127.0.0.1:3002` / `localhost:3002` / `host.docker.internal:3002` のいずれかでないと 403 を返します (DNS rebinding 緩和)。
