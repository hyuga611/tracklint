# tracklint

**Did a redesign quietly stop your form from tracking conversions?**
A conversion-tracking **integrity** linter. It reads your HTML/JSX source and **fails the PR** (exit 1 + inline annotations) when a form or CTA isn't wired for tracking. Zero-dependency, language-agnostic, runs in CI.

**その改修、フォームのコンバージョン計測を静かに壊していませんか？**
送信ボタン・フォーム・サンクスページが計測に **配線されているか** を CI で検証するリンタ。表示は正常なのに計測だけ壊れる—を PR 時点で落とす。依存ゼロ・言語非依存。

---

## Why / なぜ

Conversion tracking is the one layer that **looks fine when it breaks**. A redesign turns a `<button type="submit">` into a `<div>`, the GTM click trigger silently stops firing, unit tests still pass, visual review misses it — and nobody notices until the numbers don't add up months later (sometimes they even go *up*, because a thank-you page with no `noindex` double-counts). Runtime QA tools (ObservePoint, Trackingplan, browser debuggers) only catch this *after* it ships. `tracklint` checks the *source*, so it fails the build **before merge**. It checks facts, not prose — so it works in any language.

## Use as a GitHub Action / CIで使う（定着の本体）

```yaml
# .github/workflows/tracklint.yml
name: tracklint
on: [push, pull_request]
jobs:
  tracklint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <you>/tracklint@v1     # auto-detects files containing <form>
```

Findings show up as inline PR annotations, and the job fails (exit 1) so broken tracking can't be merged.

## Use as a CLI / ローカルで使う

```bash
npx tracklint                 # <form> を含むファイルを自動検出
npx tracklint src/ pages/     # ファイル/ディレクトリ指定も可
```

## What it catches / 検出するもの

| rule | severity | 何を落とすか |
|---|---|---|
| `submit-not-button` | error | 送信コントロールが `<div>` / `<input type=submit>` で `<button type="submit">` でない → クリック計測が要素を特定できない |
| `submit-missing-tracking` | error | 送信ボタンに一意の `id` も計測属性(`data-gtm-event` 等)も無い |
| `submit-duplicate-id` | error | 送信ボタンの `id` が重複 → クリックの二重計上/取り違え |
| `submit-dynamic-id` | warn | `id` がテンプレート展開 → 実行時の値・一意性を静的に検証できない |
| `ajax-no-conversion` | warn | AJAX 送信なのに成功時の `dataLayer.push` / `gtag` / `analytics.track` が無い |
| `thankyou-unresolved` | error | フォームのサンクスページがリポジトリに存在しない |
| `thankyou-indexable` | error | サンクスページに `noindex` が無い → インデックス漏れ・CV 二重計上 |

Exit code 1 when any `error` is found = a CI gate.（`warn` は既定では CI を落としません）

## Config / 設定（任意）

`tracklint.config.json` をリポジトリ直下に置くと上書きできます（無くても動きます）。

```json
{
  "trackingAttributes": ["data-gtm-event", "data-track"],
  "conversionCalls": ["dataLayer.push", "gtag", "analytics.track"],
  "rules": {
    "ajax-no-conversion": "error",
    "submit-missing-gtm-event-attr": "warn"
  }
}
```

## Presets / プリセット（WordPress・Meta Pixel）

フォームフレームワークや計測基盤ごとに「正しい配線」の形は違います。プリセットを有効化すると、その知識に基づく追加ルールが入り、同時に **フレームワーク特有の誤爆を抑制** します（例: Contact Form 7 は既定でサンクスへ遷移しないので `thankyou-*` を出さない）。各完了シグナルは公式ドキュメントで裏取り済み。

```json
// tracklint.config.json
{ "presets": ["wordpress", "meta"] }
```

```bash
npx tracklint --preset=wordpress,meta        # CLI でも指定可（"=" と "," 区切り）
```

### `wordpress`

| プラグイン | 検出 | 完了シグナル | 検証 |
|---|---|---|---|
| Contact Form 7 | `form.wpcf7-form` | `wpcf7mailsent`（成功時のみ発火） | ✅ 完了イベントに計測が配線されているか |
| Snow Monkey Forms | `form.snow-monkey-form` | `smf.complete` | ✅ 同上 |
| WPForms | `form.wpforms-form` | 確認タイプ3種で可変 | 🔍 検出のみ（誤爆抑制） |
| MW WP Form | `.mw_wp_form` / `submitSend` | 完了画面 or 別URL | 🔍 検出のみ（誤爆抑制） |

CF7 / Snow Monkey は「送信完了で別URLへ遷移しない」ため、`<button>` のクリック計測ではなく **完了イベントに計測を配線** するのが正解です。tracklint はこれを検証し、逆にクリック計測ルール(`submit-*`)を課しません。WPForms / MW WP Form は完了がサーバ再描画・設定依存で静的に確定できないため、**検出（＝サンクス誤爆の抑制）のみ** にとどめます（正直に success-tracking は課しません）。

| rule | severity | 何を落とすか |
|---|---|---|
| `wp-form-no-success-tracking` | warn | CF7/Snow Monkey で、完了イベントのリスナ内に計測(gtag / dataLayer.push / fbq)が無い |
| `wp-form-tracking-on-wrong-event` | warn | CF7 で CV を `wpcf7submit`（無効送信・スパムでも発火）に紐付けている → CV 水増し |

### `meta`

`fbq(...)` をコンバージョン呼び出しとして認識し、静的に確定できる破損だけを検出します。

| rule | severity | 何を落とすか |
|---|---|---|
| `meta-pixel-track-without-base` | error | `fbq('track', …)` があるのに base code(`fbq('init')` / `fbevents.js`)が無い → 送信されない |
| `meta-pixel-duplicate-init` | warn | 異なる Pixel ID で `fbq('init')` が複数 → PageView/CV の二重計上 |

> Meta Pixel の **実発火**（本当に `CompleteRegistration` が飛んだか）は静的には見えません（`--runtime` は Roadmap 参照）。GTM 経由でのみ設置している場合、生 HTML に `fbq` が現れないため検出対象外です（誤って「未設置」とは判定しません）。

サンプル: `examples/wordpress/`（`cf7-bad.html` / `cf7-good.html` / `meta-pixel-bad.html`）

## What this can and cannot see / できること・できないこと

これは **静的解析** です。「配線が存在し正しく書かれている」ことを検証しますが、**GTM/GA4 が実行時に実際に発火したことは保証しません**。以下は構造的に見えないので、`warn`/`info` に留めるか設定で抑制します。動的検証(E2E)は置き換えではなく補完です。

- GTM のコンテナ側(UI)だけで組んだトリガーは見えない（ページ側に手掛かり=id/属性があるかだけを見る）
- 別ファイル/バンドル/フレームワークのハンドラに配線された計測は追い切れない
- CMS やサーバーテンプレートが実行時に注入する `dataLayer.push` は静的ソースに無い
- HTTP ヘッダ(`X-Robots-Tag`)で付けた `noindex` は `<meta>` が無いと拾えない
- `robots.txt` の `Disallow` は `noindex` とは別物（クロール禁止であってインデックス禁止ではない）

## Roadmap

- [x] Static core: submit control / tracking hook / AJAX conversion / thank-you page — zero-dep (`src/scan.mjs`)
- [x] **GitHub Action** (`action.yml`) + inline PR annotations + self-CI dogfood
- [ ] `--runtime` mode (Playwright): 実際に送信してイベント発火とサンクス遷移を検証
- [ ] SARIF 出力（GitHub code-scanning 連携）
- [ ] baseline/allowlist（既存リポは新規違反だけで落とす）
- [x] **presets: `wordpress`**（Contact Form 7 / Snow Monkey Forms / WPForms / MW WP Form）+ **`meta`**（Meta Pixel）
- [ ] presets: Shopify / HubSpot

## Dev

```bash
node --test                 # unit tests
npm run poc                 # 壊れたサンプルで検出デモ → exit 1
npm run selfcheck           # 正しいサンプルの自己検査 → exit 0
```

MIT
