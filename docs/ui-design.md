# UI デザイン仕様書

実装の正は `frontend/css/style.css` (CSS 変数定義) と `frontend/js/{app,settings}.js`。本文書は意図とトークンの概要のみ。

## デザイン方針

- パステル基調のダークテーマ ("Mission Control" theme)
- レビュー状態をパステル色で直感的に区別 (mint=Approved / coral=Changes / peach=Pending / lavender=Review)
- 情報密度を抑え、フォントは Manrope (UI) + IBM Plex Mono (code)
- 更新ポーリング時の再描画チラつきを避ける (PR カードは fade-in なし、ヘッダーのドット pulse + stat flash のみ)

## カラートークン

`:root` で CSS 変数として定義。動的な色 (ラベル背景・エラー severity 等) は JS から `style.background` 等で注入。

| カテゴリ          | トークン (例)                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------- |
| 背景              | `--bg-deep` `--bg-surface` `--bg-overlay` `--bg-hover` `--bg-active`                      |
| テキスト          | `--text-primary` `--text-secondary` `--text-muted` `--text-link`                          |
| アクセント        | `--accent` (mint) / `--accent-dim`                                                        |
| ステータス (5 種) | `--status-{approved,changes,pending,review,merged}` + `-bg` / `-text` / `-card-bg/border` |
| ボーダー          | `--border` `--border-hover` `--border-focus`                                              |

## タイポグラフィ

7 段階のサイズスケール (`--text-xs` 〜 `--text-2xl`) と 4 段階のウェイト (`font-normal` 400 〜 `font-bold` 700)。QHD 2560px+ / 4K 3840px+ で `:root` を上書きしてスケールアップ。

## レイアウト

- ブレークポイント: 600 / 900 / 1280 / 2560 / 3840px
- 4 列グリッド (`--card-min-width: 420px`、画面幅に応じ動的調整)
- サイドバー幅 280px (QHD で 340px、4K で 420px)
- ヘッダー高 56px (QHD 68px、4K 88px)

## 主要コンポーネント

### サイドバーリポジトリ項目

```
[👁]  owner/repo                       [x]
```

- 目アイコンひとつで「表示 + 更新ポーリング」を atomic に切替 (paused === !visible、backend が真実源)
- paused 時は名前を `text-decoration: line-through` + opacity 0.55 で弱める
- 行クリックで該当セクションへスクロール、paused なら自動的に再開

### PR カード

- レビュー状態に応じて 4 色に分岐 (`.pr-status-{approved,changes,pending,review}`)
- ホバー時のみ transform + box-shadow、更新時の fade-in アニメは無し
- `tabindex=0` + クリックで詳細ペインを開く

### 詳細ペイン (右スライドイン)

- 幅 `min(560px, 90vw)` (QHD 680、4K 820)
- 開閉とも `transform: translateX` + `200ms ease-out`、`pointer-events: none` で操作遮断
- セクション: Open in GitHub / AI 要約 (任意) / Changes / **Failed checks** (赤バッジ + Actions ログへリンク) / Files / Unresolved comments
- AI 要約には disclaimer "LLM による要約。重要な判断の前に必ず原文を確認してください。" を常時表示
- Esc / オーバーレイ / × で閉じる、フォーカスは呼び出し元へ復帰

### ヘッダー

- 左: ロゴ + タイトル
- 右: stats (Total / Need review / Mine / Approved) + PR 検索 + ソートセレクト + ユーザー + Logout
- ポーリング成功時に `.last-updated` ドットを 700ms pulse、stat 値が変化したセルだけ accent 色 800ms flash

### Toast

- 画面右上、最大 3 件
- 同一メッセージ集約 (`×N` バッジ、TTL リセット)
- close ボタン付き、自動消去 5 秒
- error 種別は `role="alert"` + `aria-live="assertive"`

### 検索の空状態

検索入力で全件除外された場合、`No PRs match "<query>"` を `#pr-content` 直下に挿入。

## インタラクション

- transition: 一般 120ms ease (`--transition`)、ペイン/オーバーレイ 200ms ease-out
- focus-visible: outline 2px accent + box-shadow halo (ダーク背景でも埋もれない二重リング)
- Sort 変更時はスクロール位置を `requestAnimationFrame` で復元
- Load more クリック時は追加分先頭カードへフォーカスを移譲

## 参考

- 設計初期のモック: [docs/mockup.html](./mockup.html) (現行 UI とは乖離あり、設計意図保存目的)
- 実装スクリーンショット: [docs/screenshots/](./screenshots/)
