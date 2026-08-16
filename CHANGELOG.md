# Changelog

## 0.6.0

別のモデル（GPT-5.4）にスキャナ本体だけを渡し、「これを黙らせるマークアップを作れ」と
指示して返ってきた12件を実際に通した。**本物は3件**で、残りは設計どおりか、指摘そのものが
間違っていた（重複した `type` 属性は HTML 仕様上いちばん最初が勝つので、いまの読み方が正しい）。

3件のうち重かったのは、どれも「見なかったこと」を「問題なし」として報告する形だった。

### 送信コントロールが1つも見つからないフォームを、黙って通していた

```jsx
<form><input type="email" name="email"/><SubmitButton>送信</SubmitButton></form>
→ tracklint: 0 errors — tracking wired
```

`<SubmitButton>` が何を描画するかは静的には分からない。それ自体は README に書いてある
構造的な限界で、変えられない。問題は**黙ったこと**で、出力が「配線されている」と読める。
見えなかったのと、見て問題が無かったのは別物なので、そう言うルール
（`submit-control-not-found`）を足した。既定は warn ——Enter キーだけで送るフォームは
実在するので、error にすると正当なものまで CI を止める。

### `<FORM>` と大文字で書かれたファイルが、自動検出から静かに落ちていた

自動検出が `text.includes('<form')` で大小を区別していた。大小が混在したディレクトリでは
「1 file を見た、0 errors」と出て、**見ていない方のファイルの存在ごと消える**。
明示的にパスを渡した場合は従来も検査されていたので、既定モード（＝CI が使う方）だけの穴。

### JSX の定数式で書かれた `type` を送信コントロールとして読めていなかった

`type={"submit"}` / `type={'submit'}` / ``type={`submit`}`` が波括弧つきのまま比較され、
どれも送信ボタンとして数えられていなかった。定数だけを値として読む。補間や変数を含む式は
そのまま残す——実行時の値は分からないので、`submit-dynamic-id` として扱われるのが正しい。

### 変えていないもの

- **`id="send"` だけで `submit-missing-tracking` を満たす**のは仕様。このルールが見るのは
  「GTM が掴める手掛かりがあるか」で、id は正当な手掛かり。指摘は誤りだった。
- `<a>` や `role="button"` を送信 CTA とみなす拡張は、誤検知と引き換えになるので入れない。
  送信コントロールが見えないフォームは上の warn で拾われる。

## 0.5.0

公開版を入れて、他人が最初に打つものを打ったら出てきた。

### 知らないフラグを、走査対象のパスとして黙って受け取っていた

引数解析の末尾がどれも `else paths.push(a)` で、`--` で始まるトークンもパスとして扱っていた。
パスとして読もうとして失敗するので黙って通ることはなかったが、誰も指定していないパスに
ついてのメッセージが出ていた。何かを説明するのが仕事のツールから出る、説明になっていない
メッセージで、拒否なのか壊れているのかを利用者が区別できない。

**修正:** `-` で始まる未知のトークンは **exit 2** で拒否する。exit 2 は「実行できなかった」、
exit 1 は「問題を検出した」、exit 0 は「直すものが無い（または検査対象が無い）」。

### `--help` と `--version` が無かった

インストールした人が最初に打つものが両方とも無く、`tracklint --help` は「パスとして解釈」
され、走査結果のような文言を返して exit 0 していた。両方追加した。

`--version` は `package.json` を読む。定数に書くとリリースのたびに更新を覚えておく必要が
あり、そこが古いままになっても誰も気づかない — `@hyuga/genchi` が実際にそれで、CLI が
1リリースぶん嘘の `--version` を返していた。

### README の「マージできない」は嘘だった

「job が exit 1 で落ちるので、壊れた設定は**マージできない**」と書いていた。GitHub は、その
チェックを **required** に設定していない限りマージを止めない。既定では赤い × が付くだけで、
そのまま押せる。**required にする手順**こそがゲートにする操作なので、README をそう書き直した。

### テスト

`test/cli.test.mjs` を追加。未知フラグの拒否だけでなく、**引数なしの実行が今までどおり
通ること**も入れてある。無害な入力で鳴るゲートは CI から外され、そうなると本来の拒否も
起きなくなる。


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
