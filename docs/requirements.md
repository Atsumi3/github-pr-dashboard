# 要求仕様書

GitHub PR Dashboard (PAT 専用、ローカル単独利用前提) の機能要件・非機能要件。

## 機能要件 (FR)

### 認証

- ユーザーが PAT を入力してログイン、localStorage に保存
- 401 検知時にセットアップ画面へ自動遷移
- ログアウトで token と SW キャッシュをクリア

### リポジトリ管理

- Web UI で監視リポジトリの追加・削除・検索・自動提案
- 設定はサーバー再起動後も永続化
- 表示と更新ポーリングを 1 つのトグルで切替 (paused フラグが真実源)

### PR ダッシュボード

- 監視リポジトリの Open PR を repo 別グルーピングで表示
- ブランチ / アサイン / レビュー状態 (Approved / Changes Requested / Pending / Review Required) を表示
- PR タイトル・ブランチ・作成者で検索、status / updated / created / behind でソート
- 自動ポーリング + 手動即時更新
- 詳細ペイン: 変更ファイル / 失敗 CI チェック (Actions ログへリンク) / 未解決コメント / AI 要約 (任意)
- AI 要約には「LLM による要約。重要な判断の前に必ず原文を確認してください。」disclaimer を常時表示
- `assignee=me` フィルタ

### 表示項目 (PR 1 件あたり)

PR 番号 / タイトル / 作成者 / ブランチ / アサイン / レビュー状態 / Reviewed タグ / CI ステータスバッジ / Behind by / 古さ警告 / ラベル / 作成日時 / 更新日時

## 非機能要件 (NFR)

### インフラ

- Docker Compose で `docker compose up` のみで起動
- 設定データは Docker volume で永続化
- AI 要約使用時のシークレットは `.env` の `AI_SHARED_SECRET` で注入

### セキュリティ

- token は localStorage 平文保存 (XSS リスクは README/SECURITY.md で明示、fine-grained PAT 推奨)
- backend は token をディスク永続化しない
- ローカル単独利用前提、外部公開は想定しない
- backend `ALLOWED_ORIGINS` ベースの Origin / Referer ガード、許可外は 403
- ai-server は `AI_SHARED_SECRET` 必須 (FATAL gate)、`AI_REQUIRE_SECRET=0` でバイパス可だが非推奨。CLI は whitelist (claude/codex/gemini/chatgpt) のみ実行可、Host header allowlist で DNS rebinding 緩和
- AI 設定 API のシステムプロンプト更新は `X-Confirm-Ai-Config: 1` 必須
- token 切替検知時に backend / SW キャッシュを自動破棄
- クライアント返却エラーは固定文言。詳細は console.error のみ
- CSP: `script-src 'self'` 厳格化、`style-src 'unsafe-inline'` は動的色のため残存

### パフォーマンス

- pollInterval デフォルト 60s、15-3600s 設定可
- 同時 cache miss は inflight Promise で集約 (refresh は force で奪取)
- Service Worker で `/api/*` の GET をキャッシュ (15 分、ネットワーク失敗時のフォールバック)
- ソート変更は再 fetch せずクライアントで再描画
- `assignee=me` 経路は GraphQL search で server-side filter
- `paused` リポジトリは fetch をスキップ (API レート消費ゼロ)

### UI / UX

- パステル基調のダークテーマ
- レビュー状態を色で直感的に区別、レスポンシブ対応 (QHD/4K スケーリング)
- タブ非表示時はポーリングを 5 分間隔に低頻度化 (新着通知は継続)
- ポーリング更新時のフィードバックはヘッダーのドット pulse + stat flash のみ (PR カード本体は再描画しない)
- toast は同一メッセージ集約 (×N バッジ)、最大 3 件、close ボタン付き
- 検索全件除外時は "No PRs match" 空状態表示
- 詳細ペイン / サイドバーオーバーレイは対称アニメ
