# 要求仕様書: GitHub PR Dashboard

> 旧バージョン (Firebase OAuth 前提) は git 履歴から `docs/design-historical.md` 参照。本ドキュメントは現行 PAT 専用構成。

## 1. 概要

GitHub の任意のリポジトリにおける Pull Request の状態をリアルタイムに監視する Web ダッシュボード。
Docker Compose で起動し、ブラウザからすべての設定・操作を完結できる。**ローカル単独利用が前提**。

## 2. 目的

- 複数リポジトリにまたがる PR の状態を一画面で把握する
- レビュー待ち・アサイン状況を素早く確認し、対応漏れを防ぐ

## 3. 機能要件

### 3.1 GitHub 認証 (FR-AUTH)

| ID | 要件 | 優先度 |
|----|------|--------|
| FR-AUTH-01 | ユーザーが Personal Access Token を入力してログインできる | 必須 |
| FR-AUTH-02 | token はブラウザの localStorage に保存される。バックエンドはディスク永続化しない | 必須 |
| FR-AUTH-03 | 401 検知時にセットアップ画面へ自動遷移する | 必須 |
| FR-AUTH-04 | ログアウトできる（localStorage の token と SW キャッシュをクリア） | 必須 |
| FR-AUTH-05 | 未ログイン状態ではセットアップ画面を表示する | 必須 |

### 3.2 リポジトリ管理 (FR-REPO)

| ID | 要件 | 優先度 |
|----|------|--------|
| FR-REPO-01 | Web UI から監視対象リポジトリを追加できる | 必須 |
| FR-REPO-02 | Web UI から監視対象リポジトリを削除できる | 必須 |
| FR-REPO-03 | 監視対象リポジトリの一覧を表示できる | 必須 |
| FR-REPO-04 | リポジトリ名でGitHub上を検索し、候補から選択して追加できる | 必須 |
| FR-REPO-05 | 設定はサーバー再起動後も永続化される | 必須 |
| FR-REPO-06 | リポジトリ単位でポーリングを一時停止/再開できる | 必須 |
| FR-REPO-07 | 自分関連 PR を持つ repo を自動提案できる | 任意 |

### 3.3 PR ダッシュボード (FR-PR)

| ID | 要件 | 優先度 |
|----|------|--------|
| FR-PR-01 | 監視対象リポジトリの Open な PR を一覧表示する | 必須 |
| FR-PR-02 | 各 PR のブランチ名を表示する | 必須 |
| FR-PR-03 | 各 PR のアサイン先（assignees）を表示する | 必須 |
| FR-PR-04 | 各 PR のレビュー状態を表示する（Approved / Changes Requested / Pending / Review Required） | 必須 |
| FR-PR-05 | リポジトリ別にグルーピングして表示する | 必須 |
| FR-PR-06 | PR タイトルをクリックすると右ペインに詳細を表示する | 必須 |
| FR-PR-07 | 自分関連 PR のみフィルタリングできる (`assignee=me`) | 必須 |
| FR-PR-08 | データを自動的に定期更新する（ポーリング） | 必須 |
| FR-PR-09 | 手動でデータを即時更新できる | 必須 |
| FR-PR-10 | PR タイトル / ブランチ / 作成者で検索できる | 必須 |
| FR-PR-11 | 表示順をユーザーが切り替えられる (status / updated / created / behind) | 必須 |
| FR-PR-12 | リポジトリの表示・非表示を切り替えられる | 必須 |
| FR-PR-13 | 詳細ペインで AI 要約を呼び出せる (任意機能) | 任意 |

### 3.4 表示項目（PR 1件あたり）

| 項目 | 説明 |
|------|------|
| PR 番号 | #123 形式 |
| タイトル | PR のタイトル |
| 作成者 | アバター + ユーザー名 |
| ブランチ名 | head ブランチ名 |
| アサイン先 | assignees のアバター + ユーザー名 |
| レビュー状態 | Approved / Changes Requested / Pending / Review Required |
| Reviewed タグ | 自分がレビュー済みなら表示 |
| CI ステータス | success / failure / pending / unknown のバッジ |
| Behind by | base からの乖離（10 commit 以上で警告） |
| 古さ警告 | 7 日 / 14 日経過で段階的に強調 |
| ラベル | GitHub ラベル (色付き) |
| 作成日時 / 更新日時 | 相対表示 |

## 4. 非機能要件

### 4.1 インフラ・デプロイ (NFR-INFRA)

| ID | 要件 |
|----|------|
| NFR-INFRA-01 | Docker Compose で `docker compose up` のみで起動できる |
| NFR-INFRA-02 | 設定データは Docker volume で永続化する |
| NFR-INFRA-03 | AI 要約使用時のシークレットは `.env` の `AI_SHARED_SECRET` で注入する |

### 4.2 セキュリティ (NFR-SEC)

| ID | 要件 |
|----|------|
| NFR-SEC-01 | token は localStorage に平文保存される。XSS リスクは README/SECURITY.md で明示する |
| NFR-SEC-02 | バックエンドは token をディスクに永続化しない |
| NFR-SEC-03 | ローカル単独利用を前提とし、外部公開は想定しない |
| NFR-SEC-04 | nginx CSP は `default-src 'self'` を基本とする |
| NFR-SEC-05 | ai-server は 127.0.0.1 でのみ listen し、Host ヘッダ allowlist で DNS rebinding を緩和する |

### 4.3 パフォーマンス (NFR-PERF)

| ID | 要件 |
|----|------|
| NFR-PERF-01 | GitHub API のレート制限を考慮し、バックエンドでキャッシュする (デフォルト 60 秒 TTL) |
| NFR-PERF-02 | ポーリング間隔はデフォルト 60 秒、15-3600 秒で設定変更可能 |
| NFR-PERF-03 | 同時 cache miss は inflight Promise で集約し thundering herd を防ぐ |
| NFR-PERF-04 | ServiceWorker で `/api/*` の GET をキャッシュし、オフライン耐性を持つ |
| NFR-PERF-05 | ソート変更時は再 fetch せずクライアントで再描画する |

### 4.4 UI / UX (NFR-UI)

| ID | 要件 |
|----|------|
| NFR-UI-01 | パステル基調のダークテーマ |
| NFR-UI-02 | レビュー状態を色で直感的に区別できる |
| NFR-UI-03 | レスポンシブ対応（デスクトップ優先、QHD/4K 解像度向けスケーリング） |
| NFR-UI-04 | タブ非表示時はポーリングと UI タイマーを停止し CPU 節約 |

## 5. 前提条件

- Docker / Docker Compose v2 がインストールされていること
- GitHub Personal Access Token を発行できること
- (任意) AI 要約を使う場合: ホスト Node.js 20+ と claude/codex/gemini など対応 CLI

## 6. 用語定義

| 用語 | 定義 |
|------|------|
| PR | Pull Request |
| Open PR | マージ・クローズされていない PR |
| レビュー状態 | GitHub のレビューステータス（Approved, Changes Requested, Pending, Review Required） |
| 監視対象リポジトリ | ダッシュボードで PR を追跡する対象として登録されたリポジトリ |
| ポーリング | 一定間隔で GitHub API にデータを取得しに行く仕組み |
| PAT | GitHub Personal Access Token |
