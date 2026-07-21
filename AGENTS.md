# AGENTS.md

tracklint 自身の開発ガイド（このファイルは agents-lint で検査され、常に整合していることが保証される）。

## コマンド

- POC（意図的に壊れたフィクスチャで検出デモ → exit 1）: `npm run poc`
- 正しい配線フィクスチャの自己検査 → exit 0: `npm run selfcheck`
- テスト: `npm run test`

## 構成

- CLI 本体: `src/check.mjs`
- 検査コア（純粋関数）: `src/scan.mjs`
- 正しい配線サンプル: `examples/good/contact.html`
- 壊れた配線サンプル（意図的）: `examples/bad/contact.html`
- GitHub Action 定義: `action.yml`

## プリセット（`wordpress` / `meta`）

- 有効化: 設定ファイル tracklint.config.json の `presets` キー、または CLI `--preset=wordpress,meta`（詳細は README「Presets」節）
- WordPress フォームの完了シグナル（`wpcf7mailsent` / `smf.complete` 等）は公式ドキュメントで裏取り済み。CF7 / Snow Monkey は完了イベント配線を検証、WPForms / MW WP Form は検出のみ（静的検証不能なので誤爆抑制に徹する）。
- 追加ルールは preset 有効時のみ発火する（既定 OFF＝後方互換）。純粋関数の設計は維持（データ駆動で `WP_FORM_TYPES` に追加）。
- サンプル: `examples/wordpress/cf7-bad.html` / `examples/wordpress/cf7-good.html` / `examples/wordpress/meta-pixel-bad.html`
