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
