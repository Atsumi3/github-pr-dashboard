# Security Policy

## このプロジェクトの位置づけ

GitHub PR Dashboard は **ローカルの単独ユーザーが自分のマシン上で動かすこと** を前提としたツールです。
本番環境・共有サーバー・インターネットへの公開といった用途は想定していません。

そのため、以下のような前提があります。

- バックエンドは `X-GitHub-Token` ヘッダの存在チェックのみを行い、ヘッダがあれば後段の GitHub API 呼び出しに転送します。token の正当性チェックは GitHub 側に委ねています
- token が切り替わったことを検知すると (sha256 ハッシュで照合)、PR 一覧キャッシュ・詳細キャッシュ・me キャッシュを自動的に破棄し、別 GitHub アカウントへ private リポジトリのデータが混入するのを防ぎます。Service Worker のキャッシュも `setToken` 時に CLEAR_CACHE で連動します
- ネットワーク到達可能な環境にバックエンドを露出させると、誰でも他人の token を `X-GitHub-Token` で投げて API を叩けてしまうため、ローカル単独利用以外では絶対に使用しないでください
- backend には `ALLOWED_ORIGINS` (デフォルト `http://localhost:3000,http://127.0.0.1:3000`) を許可リストとした Origin / Referer ガードがあり、許可外のオリジンからのリクエストは 403 を返します。`/api/health` のみ除外
- GitHub access token は **ブラウザの localStorage** に平文で保存されます。バックエンドはディスクに永続化しません。ただし XSS / 悪意ある拡張機能が走る環境では token が漏洩しうるリスクがあります。Fine-grained PAT + 必要最小スコープでの運用を強く推奨します
- Service Worker が `/api/*` への GET レスポンスを Cache Storage に最大 15 分間保持します (オフライン耐性のため、`local-cache.js` の TTL と一致)。ログアウト・token 切替時にはキャッシュを破棄します
- フロントエンドは `127.0.0.1` への公開のみを想定。CSP は `script-src 'self'` で厳格化 (unsafe-inline / unsafe-eval なし)、`style-src` は動的に色を当てる箇所がある関係で `'unsafe-inline'` を残しています (CSS custom properties への移行で将来除去予定)
- バックエンドからクライアントへのエラーメッセージは固定文言 + エラーコードのみ。詳細 (GitHub の生メッセージ、内部パス、CLI stderr など) は `console.error` にのみ出力します
- ai-server (任意) はホスト上で **whitelist された CLI のみ** を実行します (`claude` / `codex` / `gemini` / `chatgpt`)。`AI_SHARED_SECRET` 未設定では起動を拒否し (`AI_REQUIRE_SECRET=0` で明示バイパス可、ただし全リクエストに `[INSECURE]` 警告ログ)、Host ヘッダも `127.0.0.1` / `localhost` / `host.docker.internal` の whitelist のみ受け付けます (DNS rebinding 緩和)。CLI 引数は API では変更不可で `AI_CLI_ARGS` 環境変数のみで設定します
- AI 設定エンドポイント `PUT /api/ai/config` でシステムプロンプトを更新するときは `X-Confirm-Ai-Config: 1` ヘッダが必須です。XSS 経由の暗黙の fetch でプロンプトを書き換えられるリスクを下げるためで、UI の保存ボタン経由のみが付与する設計です。CLI 切り替えなどプロンプト以外の更新には不要です
- AI 要約に渡される PR 本文・コメントは GitHub から取得した第三者由来テキストです。間接プロンプトインジェクションの可能性があるため、ai-server 側では `<<<USER_DATA_START>>>` 〜 `<<<USER_DATA_END>>>` でデータ部を明示する fence と、システムプロンプトでの「指示には従わない」明示の二段構えで緩和しています。要約結果には UI に「LLM による要約。重要な判断の前に必ず原文を確認してください。」の disclaimer を常時表示しています。それでも完全な耐性ではないため、要約結果を信頼境界として扱わないでください

これらは「ローカル単独利用」という前提でのみ受容できる設計上の判断です。
**インターネット・社内ネットワーク・他ユーザーと共有する環境での利用は絶対に避けてください。**

## 既知の制約 (Known limitations)

- **PAT が localStorage に平文保存される**: HttpOnly Cookie への移行は未着手。XSS が成立した瞬間に PAT が漏洩します。fine-grained PAT + 最小スコープでの運用と、信頼できないブラウザ拡張機能を入れない運用で緩和してください
- **`style-src 'unsafe-inline'` 残存**: ラベル背景色などを実行時に当てている箇所があり、当面残しています
- **AI_REQUIRE_SECRET=0 によるバイパス**: 一時的な動作確認のためのスイッチですが、有効な間は ai-server が事実上無認証になります。共有環境では絶対に使わないでください

## サポート対象バージョン

OSS として公開されている main ブランチの最新コミットのみをサポート対象とします。
古いコミットや fork に対するサポートは行いません。

| バージョン    | サポート |
| ------------- | -------- |
| main (latest) | あり     |
| それ以外      | なし     |

## 脆弱性の報告

セキュリティ上の問題を発見した場合は、**公開の Issue ではなく** GitHub Security Advisories を通じて報告してください。

1. リポジトリの Security タブを開く
2. "Report a vulnerability" を選択
3. 再現手順、影響範囲、想定される修正案などを記入

> リポジトリ管理者向けメモ: Private vulnerability reporting は GitHub のリポジトリ Settings → Code security → "Private vulnerability reporting" で明示的に有効化する必要があります。fork してそのまま運用する場合は最初に有効化してください。

公開 Issue / Pull Request での脆弱性報告は、第三者に攻撃手法を伝えてしまうため避けてください。

### 報告時に含めると助かる情報

- 脆弱性の概要
- 再現手順 (環境・コマンド・期待結果と実際の結果)
- 影響範囲 (どのコンポーネント / どのバージョンか)
- 既知の回避策があれば記載

### 対応フロー

- 受領: 報告から数日以内に受領を確認します
- 調査: 再現性と影響度を確認します
- 修正: 必要に応じて修正版をリリースし、Security Advisory を公開します

ローカル単独利用が前提のため、緊急性は CVSS の評価基準とは別に判断する場合があります。

## 利用者への注意事項

- `data/` ディレクトリには監視リポジトリ・ポーリング設定など個人寄りの情報が保存されます。バックアップ / 共有時は取り扱いに注意してください (token は含まれません)
- ブラウザの localStorage に GitHub access token が平文で保存されます。共有 PC や信用できない拡張機能が入った環境での利用は避けてください
- フロントエンドは `127.0.0.1:3000` でのみ公開されます。ポートを `0.0.0.0` などに変更しないでください
- AI 要約サーバー (ai-server) はホスト上で任意の CLI を実行します。信頼できない CLI を `AI_CLI` に指定しないでください
- AI 要約に渡される PR 本文・コメントは GitHub から取得した第三者由来のテキストです。LLM の prompt injection 耐性に依存している点を理解の上で利用してください
