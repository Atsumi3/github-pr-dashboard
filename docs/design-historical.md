# 設計仕様書: GitHub PR Dashboard

> **Note (履歴的ドキュメント)**: 本ドキュメントは初期設計時のものです。OAuth (Firebase Auth) モードと firebase-admin を用いたバックエンド ID Token 検証は **現在は実装されていません** (PAT モード専用)。実装の現状は README.md と SECURITY.md を参照してください。

## 1. システムアーキテクチャ

### 1.1 全体構成

```
┌─────────────────────────────────────────────────────────┐
│ Docker Compose                                          │
│                                                         │
│  ┌──────────────┐       ┌───────────────────────────┐   │
│  │   frontend   │       │         backend           │   │
│  │   (nginx)    │──────→│      (Node.js/Express)    │   │
│  │  :3000 → :80 │       │        :3001              │   │
│  └──────────────┘       └──────────┬────────────────┘   │
│                                    │                    │
│                           ┌────────▼────────┐           │
│                           │   data volume   │           │
│                           │  config.json    │           │
│                           └─────────────────┘           │
└─────────────────────────────────────────────────────────┘
          │                          │
          │ Firebase SDK             │ GitHub REST API
          ▼                          ▼
  ┌───────────────┐          ┌───────────────┐
  │ Firebase Auth │          │  GitHub API   │
  │ (GitHub OAuth)│          │ api.github.com│
  └───────────────┘          └───────────────┘
```

### 1.2 サービス構成

| サービス | 役割 | ポート | ベースイメージ |
|---------|------|--------|---------------|
| frontend | 静的ファイル配信 (HTML/CSS/JS) | 3000 → 80 | nginx:alpine |
| backend | REST API, GitHub API 呼び出し, データ永続化 | 3001 | node:20-alpine |

## 2. 認証設計

### 2.1 認証フロー

```
  ブラウザ              Firebase Auth           GitHub            Backend
    │                       │                     │                  │
    │─(1) signInWithPopup──→│                     │                  │
    │                       │─(2) OAuth redirect─→│                  │
    │                       │←(3) authorization───│                  │
    │←(4) credential────────│                     │                  │
    │   (idToken +                                                   │
    │    accessToken)                                                │
    │                                                                │
    │─(5) POST /api/auth/token ─────────────────────────────────────→│
    │     { idToken, githubAccessToken }                             │
    │                                                      (6) 検証  │
    │                                                      (7) 保存  │
    │←(8) { user, status: "ok" } ────────────────────────────────────│
    │                                                                │
    │─(9) GET /api/prs ─────────────────────────────────────────────→│
    │     Authorization: Bearer <idToken>                            │
    │                                                      (10) GitHub
    │                                                       API 呼出 │
    │←(11) PR data ──────────────────────────────────────────────────│
```

### 2.2 ログアウトフロー

```
  ブラウザ                          Backend
    │                                 │
    │─(1) Firebase signOut() ──→ Firebase (セッション破棄)
    │                                 │
    │─(2) DELETE /api/auth/token ────→│
    │     Authorization: Bearer ...   │
    │                          (3) config.json からトークン削除
    │←(4) { status: "ok" } ──────────│
    │                                 │
    │─(5) セットアップ画面に遷移       │
```

フロントエンド側で Firebase の signOut() を先に呼び、その後バックエンドのトークン削除 API を呼ぶ。

### 2.3 トークン管理

| トークン | 保管場所 | 用途 |
|---------|---------|------|
| Firebase ID Token | フロントエンド (メモリ) | バックエンド API の認証ヘッダー |
| GitHub Access Token | バックエンド (config.json) | GitHub API 呼び出し |

config.json 内の GitHub Access Token は平文保存となる。Docker volume のバインドマウント経由でホストからも読み取り可能だが、NFR-SEC-02（ローカル利用前提）の範囲内として許容する。

### 2.4 認証ミドルウェア

バックエンドの全 API エンドポイントに Firebase ID Token の検証ミドルウェアを適用する。

- リクエストの Authorization ヘッダーから Bearer トークンを抽出
- Firebase Admin SDK の verifyIdToken() で検証
- 検証失敗時は 401 を返す

認証が不要なエンドポイントは存在しない。すべての API は認証必須とする。

### 2.5 Firebase 設定

#### フロントエンド用（`.env` → ランタイム注入）

```
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
```

nginx の docker-entrypoint.sh がコンテナ起動時に環境変数を読み取り、`/usr/share/nginx/html/js/config.js` を生成する。

#### バックエンド用（Firebase Admin SDK）

```
GOOGLE_APPLICATION_CREDENTIALS=/app/data/firebase-service-account.json
```

Firebase Admin SDK で ID Token を検証するために、サービスアカウントキーが必要。
`./data/firebase-service-account.json` に配置し、Docker volume 経由でバックエンドに渡す。

## 3. API 設計

全エンドポイント共通:
- `Authorization: Bearer <Firebase ID Token>` ヘッダーが必須。認証失敗時は 401 を返す
- Content-Type: application/json

### 3.0 エラーレスポンス共通フォーマット

全エンドポイント共通のエラーレスポンス形式:

```json
{
  "error": {
    "code": "INVALID_TOKEN",
    "message": "Firebase ID Token is invalid or expired"
  }
}
```

| HTTP Status | code | 用途 |
|------------|------|------|
| 400 | INVALID_REQUEST | リクエストボディのバリデーション失敗 |
| 401 | INVALID_TOKEN | Firebase ID Token の検証失敗 |
| 401 | GITHUB_TOKEN_EXPIRED | GitHub Access Token が無効 |
| 404 | REPO_NOT_FOUND | リポジトリが存在しない / アクセス権なし |
| 409 | REPO_ALREADY_EXISTS | リポジトリが既に登録済み |
| 429 | RATE_LIMITED | GitHub API レート制限 |
| 500 | INTERNAL_ERROR | サーバー内部エラー |

### 3.1 認証 API

#### POST /api/auth/token

GitHub access token を保存する。

- 認証: 必須
- Request:
  ```json
  {
    "idToken": "eyJhbG...",
    "githubAccessToken": "gho_xxxx"
  }
  ```
- Response (200):
  ```json
  {
    "status": "ok",
    "user": {
      "login": "octocat",
      "avatarUrl": "https://avatars.githubusercontent.com/u/xxx"
    }
  }
  ```
- Response (401): ID Token 検証失敗

#### GET /api/auth/status

現在の認証状態を返す。

- 認証: 必須
- Response (200):
  ```json
  {
    "authenticated": true,
    "user": {
      "login": "octocat",
      "avatarUrl": "https://avatars.githubusercontent.com/u/xxx"
    },
    "hasGithubToken": true
  }
  ```
- Response (200, トークン未保存):
  ```json
  {
    "authenticated": true,
    "user": null,
    "hasGithubToken": false
  }
  ```

#### DELETE /api/auth/token

保存済みトークンを削除（ログアウト）。

- 認証: 必須
- Response (200):
  ```json
  { "status": "ok" }
  ```

### 3.2 リポジトリ管理 API

#### GET /api/repos

監視対象リポジトリの一覧を返す。

- 認証: 必須
- Response (200):
  ```json
  {
    "repos": [
      { "id": "owner/repo1", "addedAt": "2026-04-20T12:00:00Z" },
      { "id": "owner/repo2", "addedAt": "2026-04-20T13:00:00Z" }
    ]
  }
  ```

#### POST /api/repos

監視対象リポジトリを追加する。バックエンドは GitHub API (GET /repos/{owner}/{repo}) で存在確認してから config.json に追加する。

- 認証: 必須
- Request:
  ```json
  { "repo": "owner/repo-name" }
  ```
- Response (201):
  ```json
  { "status": "ok", "repo": { "id": "owner/repo-name", "addedAt": "..." } }
  ```
- Response (409): 既に登録済み
- Response (404): リポジトリが存在しない / アクセス権なし

#### DELETE /api/repos/:owner/:repo

監視対象からリポジトリを削除する。

- 認証: 必須
- Response (200):
  ```json
  { "status": "ok" }
  ```

#### GET /api/repos/search?q=keyword

GitHub 上のリポジトリを検索する。

- 認証: 必須
- Response (200):
  ```json
  {
    "items": [
      {
        "fullName": "owner/repo",
        "description": "A cool project",
        "private": false
      }
    ]
  }
  ```

### 3.3 PR API

#### GET /api/prs

全監視対象リポジトリの Open PR を返す。

- 認証: 必須
- Query Parameters:
  - `assignee` (任意): `me` を指定すると自分にアサインされた PR のみ
- Response (200):
  ```json
  {
    "updatedAt": "2026-04-20T12:00:00Z",
    "repos": [
      {
        "repo": "owner/repo1",
        "prs": [
          {
            "number": 123,
            "title": "Add new feature",
            "url": "https://github.com/owner/repo1/pull/123",
            "author": {
              "login": "user1",
              "avatarUrl": "https://..."
            },
            "branch": "feature/new-thing",
            "assignees": [
              { "login": "user2", "avatarUrl": "https://..." }
            ],
            "reviewStatus": "APPROVED",
            "reviews": [
              {
                "login": "user3",
                "state": "APPROVED",
                "avatarUrl": "https://..."
              }
            ],
            "createdAt": "2026-04-18T10:00:00Z",
            "updatedAt": "2026-04-20T08:00:00Z"
          }
        ]
      }
    ]
  }
  ```

#### POST /api/prs/refresh

キャッシュを無視して即時データを更新する。

- 認証: 必須
- Response: GET /api/prs と同一形式

### 3.4 設定 API

#### GET /api/settings

現在の設定を返す。

- 認証: 必須
- Response (200):
  ```json
  {
    "pollInterval": 300
  }
  ```

#### PUT /api/settings

設定を更新する。

- 認証: 必須
- Request:
  ```json
  {
    "pollInterval": 600
  }
  ```
- Response (200):
  ```json
  { "status": "ok", "settings": { "pollInterval": 600 } }
  ```
- Response (400): pollInterval が 60 未満または 3600 超

## 4. データ永続化

### 4.1 config.json の構造

Docker volume (`./data`) にマウントされる JSON ファイル。

```json
{
  "auth": {
    "githubAccessToken": "gho_xxxx",
    "user": {
      "login": "octocat",
      "avatarUrl": "https://..."
    }
  },
  "repos": [
    { "id": "owner/repo1", "addedAt": "2026-04-20T12:00:00Z" },
    { "id": "owner/repo2", "addedAt": "2026-04-20T13:00:00Z" }
  ],
  "settings": {
    "pollInterval": 300
  }
}
```

### 4.2 config.json の初期化

ファイルが存在しない場合（初回起動時）、store.js が以下のデフォルト構造で自動生成する:

```json
{
  "auth": null,
  "repos": [],
  "settings": {
    "pollInterval": 300
  }
}
```

読み込み時にファイルが存在しない、または JSON パースに失敗した場合も同様のデフォルト値を返す。
排他制御は行わない。シングルユーザーのローカル利用であり、書き込み頻度が低いため許容する。

### 4.3 キャッシュ

- PR データはメモリ上にキャッシュする（永続化しない）
- キャッシュ有効期間はポーリング間隔と同一（デフォルト 5 分）
- 手動リフレッシュ時はキャッシュを破棄して再取得

## 5. 画面設計

UIの詳細仕様（タイポグラフィ、スペーシング、コンポーネント仕様、インタラクション）は [UIデザイン仕様書](./ui-design.md) を参照。

### 5.1 画面遷移

```
初回アクセス
    │
    ▼
┌──────────┐    未認証    ┌────────────────┐
│ 認証確認  │────────────→│ セットアップ画面 │
│          │              │ (GitHub ログイン) │
└──────────┘              └───────┬────────┘
    │ 認証済み                     │ ログイン成功
    ▼                             ▼
┌─────────────────────────────────────┐
│          ダッシュボード               │
│  ┌────────────┐  ┌───────────────┐  │
│  │ サイドバー   │  │   PR 一覧     │  │
│  │ リポジトリ   │  │              │  │
│  │ 管理        │  │              │  │
│  └────────────┘  └───────────────┘  │
└─────────────────────────────────────┘
```

### 5.2 画面構成

#### セットアップ画面

```
┌─────────────────────────────────────────┐
│                                         │
│        GitHub PR Dashboard              │
│                                         │
│   GitHub アカウントでログインして         │
│   PR の監視を始めましょう                │
│                                         │
│   ┌─────────────────────────────┐       │
│   │  GitHub でログイン           │       │
│   └─────────────────────────────┘       │
│                                         │
└─────────────────────────────────────────┘
```

#### ダッシュボード

```
┌──────────────────────────────────────────────────────────────────────┐
│ [Logo] GitHub PR Dashboard      [自分のみ] [更新] octocat [Logout]   │
├───────────────┬──────────────────────────────────────────────────────┤
│               │                                                      │
│ 監視リポジトリ  │  owner/repo1                          更新: 2分前    │
│               │  ┌──────────────────────────────────────────────┐    │
│ owner/repo1 x │  │ #123 Add new feature           (リンク)      │    │
│ owner/repo2 x │  │ feature/branch                              │    │
│               │  │ by user1  Assign: user2  Approved            │    │
│ ────────────  │  │ 作成: 2日前  更新: 1時間前                     │    │
│ [+ 追加]      │  ├──────────────────────────────────────────────┤    │
│               │  │ #120 Fix login bug              (リンク)      │    │
│ ┌───────────┐ │  │ fix/login                                   │    │
│ │検索...     │ │  │ by user3  Assign: user2  Changes Requested  │    │
│ │ owner/repo│ │  │ 作成: 3日前  更新: 30分前                     │    │
│ │ ┌───────┐ │ │  └──────────────────────────────────────────────┘    │
│ │ │結果1  │ │ │                                                      │
│ │ │結果2  │ │ │  owner/repo2                                         │
│ │ │結果3  │ │ │  ┌──────────────────────────────────────────────┐    │
│ │ └───────┘ │ │  │ #45 Refactor API layer          (リンク)      │    │
│ └───────────┘ │  │ refactor/api                                 │    │
│               │  │ by user4  (未アサイン)  Pending                │    │
│ ────────────  │  │ 作成: 1週間前  更新: 5時間前                   │    │
│ [設定]        │  └──────────────────────────────────────────────┘    │
│               │                                                      │
└───────────────┴──────────────────────────────────────────────────────┘
```

#### ワイヤーフレーム補足

- PR タイトル (#123 Add new feature) はクリッカブルなリンク。クリックで GitHub の PR ページを新規タブで開く
- リポジトリ名の右の x は削除ボタン。クリックで確認ダイアログを表示後に削除
- [自分のみ] はトグルボタン。ON にすると自分にアサインされた PR のみ表示
- [更新] はキャッシュを破棄して即時再取得するボタン
- 検索欄はインライン展開。入力に連動してドロップダウンで候補を表示し、選択で即追加
- 検索候補にはリポジトリ名、説明文、Private/Public の区別を表示
- [設定] をクリックするとポーリング間隔の変更が可能
- 各 PR カードに表示する項目: PR番号、タイトル、ブランチ名、作成者(アバター+名前)、アサイン先(アバター+名前)、レビュー状態、作成日時(相対表示)、更新日時(相対表示)

### 5.3 レビュー状態の表示

| 状態 | 色 | 表示 |
|------|-----|------|
| Approved | 緑 (#4caf50) | チェックマーク + "Approved" |
| Changes Requested | 赤 (#d94452) | X マーク + "Changes Requested" |
| Pending | 黄 (#e6a23c) | 時計マーク + "Pending" |
| Review Required | グレー (#999999) | 人マーク + "Review Required" |

### 5.4 配色

ダーク基調のニュートラルグレー系:

| 用途 | カラーコード |
|------|------------|
| 背景 (ページ) | #1c1c1c |
| 背景 (カード) | #262626 |
| 背景 (サイドバー) | #212121 |
| テキスト (主) | #e8e8e8 |
| テキスト (副) | #999999 |
| ボーダー | #444444 |
| ホバー | #333333 |

### 5.5 レスポンシブ対応

デスクトップ優先で設計し、以下のブレークポイントで対応する。

| ブレークポイント | レイアウト |
|----------------|----------|
| 1024px 以上 | サイドバー + メインエリアの2カラム |
| 768px 〜 1023px | サイドバーを折りたたみ可能なドロワーに変更、メインエリアは全幅 |
| 768px 未満 | サイドバーはハンバーガーメニューで開閉、PR カードは縦積みで全幅 |

### 5.6 フロントエンド側のポーリング

- フロントエンドは GET /api/prs をバックエンドのポーリング間隔と同一間隔で定期呼び出しする
- ページロード時に GET /api/auth/status で認証状態を確認し、認証済みなら即座に GET /api/prs を呼び出す
- ポーリング間隔の変更は GET /api/settings から取得して反映する
- ブラウザタブが非アクティブの場合はポーリングを一時停止する (Page Visibility API)

### 5.7 エラー表示

| エラー種別 | フロントエンド表示 |
|-----------|-----------------|
| 401 Unauthorized (トークン無効) | トースト通知 + セットアップ画面にリダイレクト |
| 403 Rate Limit | バナー: 「API レート制限中です。キャッシュ済みデータを表示しています」 |
| 404 Not Found (リポジトリ) | 該当リポジトリの PR エリアに警告: 「リポジトリにアクセスできません」 |
| ネットワークエラー | バナー: 「サーバーに接続できません。最終取得データを表示しています」 |
| 検索結果 0件 | ドロップダウン内: 「該当するリポジトリが見つかりません」 |

トースト通知はページ右上に表示し、5秒後に自動で消える。
バナーはメインエリア上部に固定表示し、状況が解消されるまで表示し続ける。

## 6. バックエンド設計

### 6.1 ディレクトリ構成

```
backend/
├── Dockerfile
├── package.json
└── src/
    ├── server.js          # Express アプリケーション起動
    ├── github.js          # GitHub API クライアント
    │                      #   - PR 取得
    │                      #   - リポジトリ検索
    │                      #   - ユーザー情報取得
    ├── store.js           # config.json の読み書き
    │                      #   - トークン保存/削除
    │                      #   - リポジトリ追加/削除
    │                      #   - 設定読み込み
    ├── cache.js           # インメモリキャッシュ
    │                      #   - TTL ベースの有効期限管理
    ├── middleware/
    │   └── auth.js        # Firebase ID Token 検証ミドルウェア
    └── routes/
        ├── auth.js        # /api/auth/* ルーティング
        ├── repos.js       # /api/repos/* ルーティング
        ├── prs.js         # /api/prs/* ルーティング
        └── settings.js    # /api/settings ルーティング
```

### 6.2 GitHub API 呼び出し

使用する GitHub REST API エンドポイント:

| 用途 | エンドポイント |
|------|-------------|
| PR 一覧 | GET /repos/{owner}/{repo}/pulls?state=open |
| PR レビュー | GET /repos/{owner}/{repo}/pulls/{number}/reviews |
| リポジトリ検索 | GET /search/repositories?q={keyword} |
| ユーザー情報 | GET /user |
| リポジトリ存在確認 | GET /repos/{owner}/{repo} |

### 6.3 ポーリング設計

```
起動時
  │
  ▼
setInterval(fetchAllPRs, pollInterval)
  │
  ├── repo1: GET /repos/owner/repo1/pulls
  │          └── 各 PR: GET .../reviews
  ├── repo2: GET /repos/owner/repo2/pulls
  │          └── 各 PR: GET .../reviews
  └── キャッシュ更新
```

- リポジトリごとの PR 取得は並列実行する
- 各 PR のレビュー取得も並列実行する（1リポジトリあたり）
- GitHub API Rate Limit: 認証済みで 5,000 req/h
- フロントエンドは同一間隔で GET /api/prs を定期呼び出しし、キャッシュ済みデータを取得する
- ポーリング間隔は PUT /api/settings で変更可能。変更時はバックエンドの setInterval もリセットする

#### ポーリングライフサイクル

| 状態 | ポーリング | 理由 |
|------|----------|------|
| 起動時に auth が null (未認証) | 停止 | GitHub API を叩けない |
| POST /api/auth/token 成功後 | 開始 | トークン取得完了 |
| 監視リポジトリが 0 件 | 停止 | 取得対象がない |
| POST /api/repos でリポジトリ追加 | 即時実行 + インターバルリセット | 追加直後に結果を見たい |
| DELETE /api/repos でリポジトリ削除 | 継続（0件になったら停止） | - |
| DELETE /api/auth/token (ログアウト) | 停止 + キャッシュクリア | トークン削除済み |
| PUT /api/settings で間隔変更 | setInterval をリセット | 新しい間隔で再スケジュール |

フロントエンド側のポーリング:
- ページロード時に GET /api/settings でポーリング間隔を取得し、setInterval を設定する
- PUT /api/settings で間隔を変更した直後に setInterval をリセットする（API 成功レスポンスをトリガーに即反映）

### 6.4 エラーハンドリング

| エラー | 対応 |
|--------|------|
| 401 Unauthorized | トークン無効として認証状態をリセット、フロントに通知 |
| 403 Rate Limit | Retry-After ヘッダーに従い待機、キャッシュ済みデータを返す |
| 404 Not Found | 該当リポジトリをスキップ、一覧では警告表示 |
| ネットワークエラー | キャッシュ済みデータを返す、エラー状態をフロントに通知 |

### 6.5 Express ミドルウェア構成

server.js でのミドルウェア適用順序:

```
1. express.json()                    -- JSON ボディパース
2. middleware/auth.js                -- Firebase ID Token 検証 (全ルートに適用)
3. routes/auth.js                    -- /api/auth/*
4. routes/repos.js                   -- /api/repos/*
5. routes/prs.js                     -- /api/prs/*
6. routes/settings.js                -- /api/settings
7. GET /api/health                   -- ヘルスチェック (認証不要)
8. グローバルエラーハンドラー           -- 4引数ミドルウェア、エラーレスポンス共通フォーマットで返す
```

- CORS: nginx がリバースプロキシするため不要（同一オリジン）
- body-parser: Express 4.16+ 組み込みの express.json() を使用
- リクエストログ: console.log でリクエストメソッド・パス・ステータスコードを出力（ライブラリ不使用）

### 6.6 ヘルスチェック

```
GET /api/health
```

- 認証: 不要（唯一の認証不要エンドポイント）
- Response: `{ "status": "ok" }`
- 用途: docker-compose.yml の healthcheck で使用

### 6.7 ログ方針

ローカル利用前提のため、console.log/console.error で stdout/stderr に出力する。ログライブラリは使用しない。

| レベル | 出力先 | 内容 |
|--------|--------|------|
| info (console.log) | stdout | 起動完了、ポーリング実行、リポジトリ追加/削除、認証成功 |
| error (console.error) | stderr | GitHub API エラー、Firebase 検証失敗、ファイル I/O エラー |

GitHub API のレスポンスボディはログに含めない（データ量が大きいため）。ステータスコードとエンドポイントのみ出力する。

### 6.8 firebase-service-account.json 不在時の起動挙動

GOOGLE_APPLICATION_CREDENTIALS で指定されたファイルが存在しない場合:

- Firebase Admin SDK の初期化をスキップし、警告ログを出力する
- バックエンドは起動する（クラッシュしない）
- 全 API エンドポイントが 401 を返す（ID Token の検証ができないため）
- フロントエンド側でセットアップ画面が表示され、ログインを試みてもバックエンド認証で失敗する
- コンソールに「firebase-service-account.json が見つかりません。セットアップ手順を確認してください」と出力する

## 7. フロントエンドファイル構成

### 7.1 ディレクトリ構成

```
frontend/
├── Dockerfile
├── nginx.conf             # リバースプロキシ設定含む
├── docker-entrypoint.sh   # 環境変数 → config.js 注入
├── index.html             # ダッシュボード
├── setup.html             # セットアップ画面
├── css/
│   └── style.css
└── js/
    ├── config.js           # Firebase 設定値（ランタイム生成、docker-entrypoint.sh が環境変数から生成）
    ├── firebase-init.js    # Firebase 初期化 + OAuth
    ├── api.js              # バックエンド API クライアント
    ├── app.js              # ダッシュボード描画・ポーリング
    └── settings.js         # リポジトリ管理 UI
```

### 7.2 config.js のフォーマット

docker-entrypoint.sh がコンテナ起動時に環境変数から生成する:

```js
window.__FIREBASE_CONFIG__ = {
  apiKey: "your-api-key",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id"
};
```

HTML からの読み込み:

```html
<script src="/js/config.js"></script>
<script src="/js/firebase-init.js"></script>
<script src="/js/api.js"></script>
<script src="/js/app.js"></script>
```

config.js を先頭で読み込み、firebase-init.js が window.__FIREBASE_CONFIG__ を参照して Firebase を初期化する。
バンドラーは使用しない。script タグの読み込み順で依存関係を解決する。

### 7.3 docker-entrypoint.sh

```bash
#!/bin/sh
# 環境変数から config.js を生成
cat > /usr/share/nginx/html/js/config.js << EOF
window.__FIREBASE_CONFIG__ = {
  apiKey: "${FIREBASE_API_KEY}",
  authDomain: "${FIREBASE_AUTH_DOMAIN}",
  projectId: "${FIREBASE_PROJECT_ID}"
};
EOF

# nginx を起動
exec nginx -g 'daemon off;'
```

### 7.4 Firebase SDK の読み込み

Firebase Web SDK v11 を CDN から読み込む:

```html
<script type="module">
  import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
  import { getAuth, signInWithPopup, signOut, GithubAuthProvider }
    from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
</script>
```

Firebase SDK v11 は ES Module 形式のため、type="module" で読み込む。
firebase-init.js は ES Module として実装する。

### 7.5 相対日時表示

外部ライブラリを使用せず、自前で実装する。

```
60秒未満      → "たった今"
60秒〜60分    → "X分前"
1時間〜24時間  → "X時間前"
1日〜7日      → "X日前"
7日〜30日     → "X週間前"
30日以上      → "Xヶ月前"
```

PR データ更新時（ポーリング取得時）にすべてのカードの日時表示を再描画する。ポーリング間隔内での表示更新は行わない。

### 7.6 nginx.conf

```nginx
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://backend:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

フロントエンドから直接バックエンドのポートを叩かず、nginx 経由で統一する。

### 7.7 アクセシビリティ方針

ローカル利用前提のため、最低限の対応に留める:

- :focus-visible によるフォーカスリング表示（キーボードナビゲーション用）
- ボタン・リンクに適切な aria-label を付与
- 確認ダイアログは Escape キーで閉じられるようにする
- トースト通知に aria-live="polite" を設定
- スクリーンリーダーの完全対応はスコープ外

## 8. Docker Compose 設計

### 8.1 docker-compose.yml

```yaml
services:
  backend:
    build: ./backend
    expose:
      - "3001"
    volumes:
      - ./data:/app/data
    environment:
      - GOOGLE_APPLICATION_CREDENTIALS=/app/data/firebase-service-account.json
      - NODE_ENV=production
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3001/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    restart: unless-stopped

  frontend:
    build: ./frontend
    ports:
      - "127.0.0.1:3000:80"
    depends_on:
      backend:
        condition: service_healthy
    environment:
      - FIREBASE_API_KEY=${FIREBASE_API_KEY}
      - FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN}
      - FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID}
    restart: unless-stopped
```

ポートバインドを `127.0.0.1:3000:80` に限定し、ローカルからのみアクセス可能にする (NFR-SEC-02)。

Firebase 設定値はビルド時引数ではなくランタイム環境変数として渡す。frontend の docker-entrypoint.sh がコンテナ起動時に環境変数を読み取り、`config.js` を動的に生成する。これにより `.env` 変更時にイメージの再ビルドが不要になる。

### 8.2 環境変数

`.env.example`:

```
# Firebase Authentication (Frontend)
FIREBASE_API_KEY=your-api-key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
```

### 8.3 ファイル配置

```
./data/
├── config.json                      # アプリ設定 (自動生成)
└── firebase-service-account.json    # Firebase Admin SDK 用 (手動配置)
```

`firebase-service-account.json` はユーザーが Firebase コンソールからダウンロードし、`./data/` に配置する。

### 8.4 Dockerfile (backend)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY src/ ./src/
EXPOSE 3001
USER node
CMD ["node", "src/server.js"]
```

- non-root ユーザー (node) で実行
- pnpm を使用（corepack 経由で有効化）
- ./data は volume マウントのため COPY しない

### 8.5 Dockerfile (frontend)

```dockerfile
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY index.html setup.html /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
ENTRYPOINT ["/docker-entrypoint.sh"]
```

- nginx:alpine のデフォルト entrypoint を docker-entrypoint.sh で置き換える
- config.js はランタイム生成のため COPY に含めない（docker-entrypoint.sh が生成）

### 8.6 .dockerignore

```
node_modules/
.git/
.env
.env.*
data/
docs/
*.md
.dockerignore
docker-compose.yml
```

data/ を除外することで firebase-service-account.json がビルドコンテキストに含まれることを防ぐ。

### 8.7 パッケージマネージャ

pnpm を使用する。

backend/package.json の依存パッケージ:

```json
{
  "name": "pr-dashboard-backend",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/server.js"
  },
  "dependencies": {
    "express": "4.21.2",
    "firebase-admin": "13.0.2"
  }
}
```

- HTTP クライアント: Node.js 20 組み込みの fetch (undici) を使用。追加パッケージ不要
- GitHub API の呼び出し時ヘッダー: Authorization: token {accessToken}, Accept: application/vnd.github.v3+json, User-Agent: pr-dashboard

## 9. OAuth スコープ

Firebase Auth の GitHub プロバイダーに設定するスコープ:

| スコープ | 用途 |
|---------|------|
| repo | Private リポジトリの PR にアクセス |
| read:org | Organization リポジトリの参照 |

スコープはフロントエンドのコードで設定する（Firebase コンソールでの設定は不要）:

- firebase-init.js で GithubAuthProvider の addScope('repo') と addScope('read:org') を呼び出す
- Firebase コンソールにはスコープ設定画面がないため、コード側で追加する

## 10. セットアップ手順

ダッシュボードを起動するまでに必要な事前準備。

### 10.1 GitHub OAuth App の作成

1. GitHub にログインし、Settings > Developer settings > OAuth Apps > New OAuth App を開く
2. 以下を入力:
   - Application name: 任意 (例: PR Dashboard)
   - Homepage URL: http://localhost:3000
   - Authorization callback URL: 空欄のまま（手順 10.2-4 で取得後に設定する）
3. 「Register application」をクリック
4. Client ID と Client Secret を控える（Client Secret は「Generate a new client secret」で生成）

### 10.2 Firebase プロジェクトのセットアップ

1. Firebase コンソール (https://console.firebase.google.com) を開き、「プロジェクトを作成」
2. プロジェクト名を入力して作成を完了する
3. 左メニュー > Authentication > 「始める」> Sign-in method タブ > 「新しいプロバイダを追加」> GitHub を選択
4. 表示された画面で:
   - Client ID: 手順 10.1-4 で取得した値を入力
   - Client Secret: 手順 10.1-4 で取得した値を入力
   - 画面下部に表示される「コールバック URL」をコピー
   - 「保存」をクリック
5. GitHub に戻り、手順 10.1 で作成した OAuth App の Authorization callback URL に、手順 10.2-4 でコピーした URL を貼り付けて「Update application」
6. Firebase コンソール > プロジェクト設定（左メニュー歯車アイコン）> 全般 から以下を取得:
   - ウェブ API キー → `.env` の FIREBASE_API_KEY
   - プロジェクト ID → `.env` の FIREBASE_PROJECT_ID
   - Auth domain は「プロジェクトID.firebaseapp.com」の形式 → `.env` の FIREBASE_AUTH_DOMAIN
7. プロジェクト設定 > サービスアカウント タブ > 「新しい秘密鍵の生成」をクリック
8. ダウンロードされた JSON ファイルを `./data/firebase-service-account.json` に配置

OAuth スコープ (repo, read:org) はフロントエンドのコードで自動設定されるため、ユーザー側での設定は不要。

### 10.3 アプリケーションの起動

```bash
# 1. .env を作成
cp .env.example .env
# → FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID を記入

# 2. data ディレクトリにサービスアカウントキーを配置
cp ~/Downloads/your-project-firebase-adminsdk-xxxxx.json ./data/firebase-service-account.json

# 3. 起動
docker compose up -d
```

ブラウザで http://localhost:3000 にアクセスし、GitHub でログインする。

## 11. 技術スタック一覧

| レイヤー | 技術 | バージョン |
|---------|------|-----------|
| Backend ランタイム | Node.js | 20 LTS |
| Backend フレームワーク | Express | 4.x |
| Backend 認証検証 | Firebase Admin SDK | 13.x |
| Frontend 配信 | nginx | alpine |
| Frontend 認証 | Firebase Authentication | Web SDK v11 |
| API | GitHub REST API | v3 |
| コンテナ | Docker Compose | v2 |
| データ永続化 | JSON ファイル | - |
