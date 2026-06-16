# Local PR Notifier + AI Review

ブラウザのタブを開いていなくても、自分にレビュー依頼が来た PR を定期的に検知して macOS 通知を出し、AI でローカルレビューを生成する常駐の仕組みです。Docker スタック（backend / frontend）が起動していなくても動作します。

## 仕組み

launchd が一定間隔で `notify.js` を 1 回実行します（常駐 setInterval ではなく「実行して終了」を繰り返す方式）。各実行で:

1. `gh search prs --review-requested=@me --state=open` で自分にレビュー依頼が来た open PR を取得
2. `data/notifier-state.json` と比較し、新規に出現した PR を抽出
3. 新規 PR ごとに macOS 通知（osascript）を表示
4. `runAiReview` が有効なら `gh pr diff` の差分を `claude` 等の CLI に渡してレビューを生成し、`data/reviews/<repo>__<番号>.md` に保存
5. 状態を保存

初回実行（state ファイルが無いとき）は通知を出さず、現在の依頼分を baseline として記録するだけです（既存の依頼でスパムしないため）。

state は毎回「現在 open かつ review-requested」の PR だけで再構築されるため、クローズ済み PR は自動的に消え、ファイルは肥大化しません。

## 必要なもの

- `gh`（認証済み: `gh auth status` で確認）。`--review-requested=@me` は gh の認証ユーザーを対象にします
- `claude` などの CLI（AI レビューを使う場合。使わないなら `runAiReview` を false に）
- `node` / `osascript`（macOS 標準）

## 設定: `notifier.config.json`

| キー              | 既定値     | 説明                                                            |
| ----------------- | ---------- | --------------------------------------------------------------- |
| `cli`             | `"claude"` | レビューに使う CLI コマンド                                     |
| `cliArgs`         | `[]`       | CLI に渡す追加引数                                              |
| `runAiReview`     | `true`     | false にすると通知のみ（AI レビューを実行しない）               |
| `maxDiffBytes`    | `100000`   | CLI に渡す差分の最大バイト数（超過分は切り詰め）                |
| `reviewTimeoutMs` | `120000`   | CLI 実行のタイムアウト                                          |
| `repoFilter`      | `[]`       | 対象リポジトリを `owner/name` で限定。空なら全 review-requested |
| `searchLimit`     | `50`       | gh search の取得上限                                            |

実行間隔は launchd の `StartInterval`（既定 300 秒）で決まります。変更する場合は plist テンプレートの `StartInterval` を編集してから再インストールしてください。

## インストール

```sh
./notifier/install.sh
```

これで以下を生成します:

- plist を `~/Library/LaunchAgents/com.github-pr-dashboard.notifier.plist`（node / gh / claude の絶対パスと PATH を解決済み）
- 通知用アプレット `data/PR Dashboard.app`（osacompile で生成）。通知の送信元アプリ名を「PR Dashboard」にするためのもの。これが無い場合は通常の osascript で通知し、送信元名は node の署名名（Node.js Foundation）になる

続けて表示されるコマンドでロードします:

```sh
launchctl unload "$HOME/Library/LaunchAgents/com.github-pr-dashboard.notifier.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.github-pr-dashboard.notifier.plist"
```

初回の通知時に「PR Dashboard」宛の通知許可ダイアログが出たら許可してください。

## 単発の手動実行（動作確認）

```sh
node notifier/notify.js
```

## ログ・出力先

- 実行ログ: `data/notifier.log`
- launchd の stdout/stderr: `data/notifier.launchd.log`
- AI レビュー結果: `data/reviews/<owner>__<repo>__<番号>.md`

## 状態確認・アンインストール

```sh
launchctl list | grep com.github-pr-dashboard.notifier
launchctl unload "$HOME/Library/LaunchAgents/com.github-pr-dashboard.notifier.plist"
rm "$HOME/Library/LaunchAgents/com.github-pr-dashboard.notifier.plist"
```

## 注意

- レビュー結果はローカル（`data/reviews/`）に保存するだけで、GitHub には一切書き込みません
- レビューが失敗した PR も state に記録されるため、同じ実行では再試行しません（次に新しく出現したときのみ再度処理）
- PR 差分は CLI に「データのみ」として渡し、プロンプトインジェクションに従わないよう指示しています
