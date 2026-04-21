# Contributing Guide

GitHub PR Dashboard へのコントリビュートを検討いただきありがとうございます。
このドキュメントでは Issue / Pull Request の出し方と、ローカル開発環境のセットアップ手順をまとめます。

> 本プロジェクトは **ローカル単独利用** を目的としています。新機能の提案も「ローカルでの単独利用において役立つか」を判断軸としてください。

## 目次

- [行動規範](#行動規範)
- [Issue の出し方](#issue-の出し方)
- [Pull Request の出し方](#pull-request-の出し方)
- [ローカル開発手順](#ローカル開発手順)
- [コーディング規約](#コーディング規約)
- [コミットメッセージ](#コミットメッセージ)

## 行動規範

オープンで歓迎されるコミュニティを保つため、以下を守ってください。

- 相手を尊重した言葉遣いを心がける
- 個人攻撃 / 差別的な発言を行わない
- 建設的なフィードバックを心がける

## Issue の出し方

Issue を立てる前に、既存の Issue で同じ内容が報告されていないか検索してください。

### バグ報告

以下を含めてください。

- 概要 (一行で)
- 再現手順
- 期待する挙動 / 実際の挙動
- 環境情報 (OS, Docker バージョン, ブラウザなど)
- 関連するログ (ターミナル出力 / ブラウザコンソール)

機微な情報 (token, リポジトリ名, ユーザー名) は伏字にしてください。

### 機能要望

以下を含めてください。

- 解決したい課題 (なぜそれが必要か)
- 提案する解決策
- 代替案 (検討したが採用しなかったもの)

「ローカル単独利用」の前提に沿わない要望はクローズすることがあります。

### セキュリティ問題

公開 Issue ではなく [SECURITY.md](./SECURITY.md) の手順に従ってください。

## Pull Request の出し方

1. リポジトリを fork する
2. main から作業ブランチを切る (例: `feature/add-x`, `fix/y-bug`)
3. 変更をコミットする (1 PR = 1 トピック)
4. PR を出す前にローカルで動作確認する
5. PR テンプレートに沿って説明を記載する

### PR に含めてほしい情報

- なぜこの変更が必要か (背景 / 解決する課題)
- 何を変更したか (主な変更点を箇条書き)
- どう確認したか (再現手順 / スクリーンショット)
- 既知の制約や TODO

レビューしやすくするため、無関係な変更 (フォーマット一括変更など) は別 PR に分けてください。

### マージ条件

- main が壊れない
- ローカルで `docker compose up` が成功する
- 関連 Issue がある場合はリンクされている
- レビュアーの approve がある

## ローカル開発手順

### 必要要件

- Docker Desktop (Compose v2 以降)
- Node.js 20 以上 (AI 要約サーバーをホストで動かす場合のみ)
- ブラウザ (Chrome / Firefox / Safari の最新版)
- GitHub Personal Access Token (`repo` / `public_repo` / 必要に応じて `read:org`)

### 初期セットアップ

```bash
# 1. リポジトリを clone (まずは fork してから)
git clone https://github.com/<your-fork>/github-pr-dashboard.git
cd github-pr-dashboard

# 2. 環境変数ファイルを用意
cp .env.example .env
# AI 要約機能を使う場合は AI_SHARED_SECRET を記入する
#   openssl rand -hex 32 で生成した値を入れる
```

### 起動

```bash
# Docker Compose で frontend / backend を起動
docker compose up --build

# AI 要約機能を使うなら、別ターミナルで AI server を起動
# .env と同じ AI_SHARED_SECRET 値を環境変数で渡すこと
cd ai-server
AI_SHARED_SECRET=<.env と同じ値> node server.js
```

ブラウザで http://127.0.0.1:3000 を開いてセットアップ画面に従ってください。

詳しい認証モードの違いは [README.md](./README.md) を参照してください。

### コードを変更したとき

| 変更箇所 | 反映方法 |
|---------|---------|
| frontend (HTML/CSS/JS) | コンテナのボリュームマウントを使っていない構成のため、`docker compose up --build` で再ビルド |
| backend (Node.js) | 同上 (`--build`) |
| ai-server | プロセスを再起動 (`Ctrl-C` → `node server.js`) |

開発中は backend を `pnpm start` でホスト直接起動するのも可能です (その場合 frontend からのアクセスにはポート設定の調整が必要)。

### データのリセット

リポジトリ設定や認証トークンを初期化したい場合は `data/` 配下のファイルを削除してください。

```bash
# Docker volume と config を全削除 (注意: 認証も消えます)
docker compose down
rm -rf data/config.json
```

## コーディング規約

### 共通

- 文字コードは UTF-8、改行コードは LF
- ファイル末尾に改行を入れる
- インデントはスペース 2 個 (JS / HTML / CSS / YAML / JSON)
- 不要な依存追加は避ける (本プロジェクトはランタイム依存を最小化する方針)

### JavaScript (frontend / backend / ai-server)

- ES Modules (`import` / `export`) を使う
- `const` を優先し、必要な場合のみ `let`
- セミコロンあり
- 変数名 / 関数名は camelCase、クラス名は PascalCase
- 非同期処理は `async / await` を使い、`.then()` チェーンは避ける

### HTML / CSS

- セマンティックな HTML タグを使う
- CSS クラス名は kebab-case
- 既存のデザイントークン (CSS 変数 / スタイル) を尊重し、勝手に新しい配色を増やさない

### 依存パッケージ

- バージョンは完全固定 (`^` / `~` / `latest` 禁止)
- lock ファイルに従ってインストールする
- 公式レジストリ以外からのインストールは行わない

## コミットメッセージ

Conventional Commits に近い形式を推奨します (必須ではありません)。

```
<type>: <subject>

<body>
```

`type` の例:

- `feat`: 新機能
- `fix`: バグ修正
- `docs`: ドキュメントのみの変更
- `refactor`: 振る舞いを変えないコード変更
- `chore`: ビルド設定や依存更新など

例:

```
feat: add filter for assigned PRs
fix: handle GitHub API 403 rate limit gracefully
docs: clarify PAT scope in README
```

---

質問や疑問は Issue でお気軽にどうぞ。
