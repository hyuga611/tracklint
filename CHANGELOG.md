# Changelog

## 0.4.1

- **`npm i -g` や `npx` で入れた CLI が、何もせずに終了していた。** 入口判定が `process.argv[1]` を
  そのまま `import.meta.url` と比べていた。この2つはシンボリックリンク越しに呼ばれると一致しない
  （`argv[1]` はリンク、`import.meta.url` は解決済みの実パス）ので、install した版は本体を一度も
  実行しないまま exit 0 で終わっていた。リンタにとってこれは最悪の壊れ方で、「問題を見つけなかった」
  と「一度も動いていない」が区別できない。終了コードを読む CI からも同じに見えるので、これを CI に
  入れていた人は、何も守られていない状態で緑を見ていたことになる。公開物を clean なコンテナに
  `npm i -g` して測った結果は、修正前が出力0バイト、修正後は出力あり。
- リンクを解決してから比較するようにし、`test/entrypoint.test.mjs` を追加した。既存のテストは
  すべて関数を import して確かめており、bin を一度も実行していなかったので何も気づけなかった。
  この修正を戻すと、このテストは落ちる（確認済み）。

## 0.4.0

Precision hardening, driven by a real-world audit of **1,380 public HTML / JSX / Vue / PHP files**
(783 tuning + 597 hold-out, collected 2026-07). v0.3.0 failed CI on **58% of them (455 files)**;
v0.4.0 fires on **5**, and every one is genuine. No real finding was lost — all 8 surviving
findings across both corpora were also caught by v0.3.0.

- **`submit-not-button`**: `<input type="submit">` / `<input type="image">` are legitimate,
  trackable submit controls and are no longer errors. In 783 real files this rule fired 173 times
  and **every single hit was an `<input type=submit>`** — not one genuine case (a `<div>`/`<a>`
  driving `form.submit()`) existed in the corpus. The rule now only flags non-form-control
  elements. Inputs fall through to the normal wiring checks like `<button type="submit">` does.
- **Measurement gate**: `submit-missing-tracking`, `submit-missing-gtm-event-attr` and
  `ajax-no-conversion` stay silent when **no analytics exists anywhere in the scanned project**
  (GTM / gtag / dataLayer / fbq / analytics.track / Matomo / Plausible …). 754 of the 783 files
  had no measurement stack at all — telling them their conversions aren't tracked is noise.
  The CLI decides this across **all target files** (GTM usually lives in a shared header) and
  prints why it went quiet. `scan()` takes `measures` to receive that project-level answer.
- **Lead-form gate**: the same rules only apply to forms that collect contact information
  (`type=email` / `type=tel` / `textarea` / contact-ish `name`・`placeholder`). Search, filter and
  sort forms are not conversions. Judged by the input fields, **not** by the button label — a
  "Search availability" button on a booking form is a real conversion and must stay caught.
- Added real-world regression tests: 5 genuine findings that must stay caught, plus the
  false-positive shapes (search/filter forms, no-analytics projects) that must stay silent.

## 0.3.0

English CLI output.

## 0.2.0

`wordpress` and `meta` presets (`presets: [...]` / `--preset=wordpress,meta`, off by default).
Detects CF7 / Snow Monkey / WPForms / MW WP Form, verifies tracking is wired to the completion
event (`wpcf7mailsent` / `smf.complete`), and adds `meta-pixel-track-without-base` /
`meta-pixel-duplicate-init`.

## 0.1.0

Initial release. Conversion-tracking integrity linter: submit controls, tracking hooks,
AJAX success-time conversions, and thank-you page existence / `noindex`. Zero-dependency,
framework-agnostic, GitHub Action with PR annotations.
