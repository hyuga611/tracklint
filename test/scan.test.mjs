import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, tokenize, hasNoindex, resolveDest, collectIds, stripComments } from '../src/scan.mjs';

// 既定の前提＝「計測しているサイト」。CLI は対象ファイル全体を見て measures を決めるので、
// 単体テストでは明示的に true を渡す（計測が無いプロジェクトの挙動は専用のテストで見る）。
const ok = { exists: () => true, readText: () => '<meta name="robots" content="noindex">', measures: true };

function rules(findings) {
  return findings.map((f) => f.rule);
}

// 実データ監査（公開リポジトリの HTML/JSX 783本・2026-07）由来。
// v0.3.0 は <input type="submit"> を submit-not-button として 173件 error にしていたが、
// そのうち本物（div/a/span を送信ボタンにしている）は 0件だった。正当なHTMLを落としていただけ。
test('submit-not-button: <input type=submit> は正当な送信コントロールなので落とさない', () => {
  const f = scan('<form data-thankyou="t.html"><input type="email" name="email"><input type="submit" id="s1" data-gtm-event="lead" value="送信"></form>', ok);
  assert.equal(rules(f).includes('submit-not-button'), false);
  assert.deepEqual(rules(f), []);
});

test('submit-not-button: <input type=submit> でも計測フックが無ければ submit-missing-tracking', () => {
  const f = scan('<form data-thankyou="t.html"><input type="email" name="email"><input type="submit" value="送信"></form>', ok);
  assert.ok(rules(f).includes('submit-missing-tracking'));
  assert.equal(rules(f).includes('submit-not-button'), false);
});

test('submit-not-button: onclick で submit する div を検出', () => {
  const f = scan('<form><div onclick="document.forms[0].submit()">送信</div></form>', ok);
  assert.ok(rules(f).includes('submit-not-button'));
});

test('正しい button type=submit + id + data-gtm-event は指摘しない', () => {
  const f = scan('<form data-thankyou="t.html"><input type="email" name="email"><button type="submit" id="s1" data-gtm-event="lead">送信</button></form>', ok);
  assert.deepEqual(rules(f), []);
});

test('submit-missing-tracking: id も計測属性も無い送信ボタン', () => {
  const f = scan('<form data-thankyou="t.html"><input type="email" name="email"><button type="submit">送信</button></form>', ok);
  assert.ok(rules(f).includes('submit-missing-tracking'));
});

test('submit-duplicate-id: id が重複していれば error', () => {
  const f = scan('<form data-thankyou="t.html"><input type="email" name="email"><button type="submit" id="dup">送信</button></form>', {
    ...ok,
    isDupId: (id) => id === 'dup',
  });
  assert.ok(rules(f).includes('submit-duplicate-id'));
});

test('submit-dynamic-id: テンプレート展開された id は warn', () => {
  const f = scan('<form data-thankyou="t.html"><input type="email" name="email"><button type="submit" id="s-{{n}}">送信</button></form>', ok);
  const hit = f.find((x) => x.rule === 'submit-dynamic-id');
  assert.ok(hit);
  assert.equal(hit.severity, 'warn');
});

test('thankyou-unresolved: サンクスページが存在しないと error', () => {
  const f = scan('<form action="thanks.html"><input type="email" name="email"><input type="email" name="email"><button type="submit" id="s1">送信</button></form>', {
    filename: 'contact.html',
    exists: () => false,
    readText: () => null,
  });
  assert.ok(rules(f).includes('thankyou-unresolved'));
});

test('thankyou-indexable: noindex の無いサンクスページは error', () => {
  const f = scan('<form action="thanks.html"><input type="email" name="email"><input type="email" name="email"><button type="submit" id="s1">送信</button></form>', {
    filename: 'contact.html',
    exists: () => true,
    readText: () => '<head><title>done</title></head>',
  });
  assert.ok(rules(f).includes('thankyou-indexable'));
});

test('ajax-no-conversion: AJAX 送信で計測呼び出しが無いと warn', () => {
  const html =
    '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit" id="s1" data-gtm-event="x">送信</button></form>' +
    '<script>form.addEventListener("submit",e=>{e.preventDefault();fetch("/x")})</script>';
  const f = scan(html, ok);
  const hit = f.find((x) => x.rule === 'ajax-no-conversion');
  assert.ok(hit);
  assert.equal(hit.severity, 'warn');
});

test('ajax: dataLayer.push があれば ajax-no-conversion は出ない', () => {
  const html =
    '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit" id="s1" data-gtm-event="x">送信</button></form>' +
    '<script>form.addEventListener("submit",e=>{e.preventDefault();fetch("/x").then(()=>dataLayer.push({event:"x"}))})</script>';
  const f = scan(html, ok);
  assert.equal(rules(f).includes('ajax-no-conversion'), false);
});

test('config.rules で severity を off にできる', () => {
  const html = '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit">送信</button></form>';
  const f = scan(html, { ...ok, config: { rules: { 'submit-missing-tracking': 'off' } } });
  assert.equal(rules(f).includes('submit-missing-tracking'), false);
});

test('tokenize: JSX の id={expr} を属性として読む', () => {
  const t = tokenize('<button id={foo} type="submit">x</button>');
  assert.equal(t[0].attrs.get('id'), '{foo}');
  assert.equal(t[0].attrs.get('type'), 'submit');
});

test('hasNoindex: robots/googlebot の noindex を検出、content 無しは false', () => {
  assert.equal(hasNoindex('<meta name="robots" content="noindex,nofollow">'), true);
  assert.equal(hasNoindex('<meta name="googlebot" content="none">'), true);
  assert.equal(hasNoindex('<meta name="description" content="noindex">'), false);
  assert.equal(hasNoindex('<title>x</title>'), false);
});

test('resolveDest: 相対・ルート絶対・ディレクトリ・外部URL', () => {
  assert.equal(resolveDest('a/b/contact.html', 'thanks.html'), 'a/b/thanks.html');
  assert.equal(resolveDest('a/b/contact.html', '/thanks/'), 'thanks/index.html');
  assert.equal(resolveDest('a/b/contact.html', '../done.html'), 'a/done.html');
  assert.equal(resolveDest('a/contact.html', 'https://example.com/t'), null);
  assert.equal(resolveDest('a/contact.html', '#'), null);
});

test('collectIds: 動的 id は集計から除外', () => {
  assert.deepEqual(collectIds('<button id="a"></button><button id="b-{{n}}"></button>'), ['a']);
});

// --- 公開前レビューで見つかった不具合の回帰テスト ---

test('JSX: onClick={() => gtag(...)} の > でタグが壊れず、インライン計測を認識', () => {
  const f = scan('<form data-thankyou="t.html"><input type="email" name="email"><button onClick={() => gtag("event","cv")}>送信</button></form>', ok);
  assert.equal(rules(f).includes('submit-missing-tracking'), false);
});

test('JSX: data-gtm-event が矢印関数の後ろにあっても脱落しない', () => {
  const t = tokenize('<button onClick={() => track()} data-gtm-event="cta">x</button>');
  assert.equal(t[0].attrs.get('data-gtm-event'), 'cta');
});

test('コメントアウトされた壊れフォームは検出しない（false-positive回避）', () => {
  const html =
    '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit" id="ok" data-gtm-event="x">送信</button></form>' +
    '<!-- 旧: <form action="old.php"><input type="submit"></form> -->';
  assert.deepEqual(rules(scan(html, ok)), []);
});

test('hasNoindex: コメントアウトされた noindex は無効', () => {
  assert.equal(hasNoindex('<head><!-- <meta name="robots" content="noindex"> --><title>x</title></head>'), false);
});

test('thankyou-indexable: noindexがコメントアウトされていれば検出（false-negative回避）', () => {
  const f = scan('<form action="thanks.html"><input type="email" name="email"><input type="email" name="email"><button type="submit" id="s1">送信</button></form>', {
    filename: 'contact.html',
    exists: () => true,
    readText: () => '<head><!-- <meta name="robots" content="noindex"> --><title>x</title></head>',
  });
  assert.ok(rules(f).includes('thankyou-indexable'));
});

test('<script>/文字列リテラル内の <form> は実マークアップ扱いしない', () => {
  const f = scan('<script>const t = "<form action=\\"/thanks.html\\"><input type=\\"submit\\"></form>";</script>', {
    exists: () => false,
    readText: () => null,
  });
  assert.deepEqual(rules(f), []);
});

test('collectIds: コメント内の id は集計しない', () => {
  assert.deepEqual(collectIds('<button id="s"></button><!-- <button id="s"></button> -->'), ['s']);
});

test('自己終了誤検出: 未クオート action=/thanks/ でフォームがスキップされない', () => {
  const t = tokenize('<form action=/thanks/>');
  assert.equal(t[0].selfClose, false);
  assert.equal(t[0].attrs.get('action'), '/thanks/');
});

test('resolveDest: ルート "/" は index.html（先頭スラッシュを付けない）', () => {
  assert.equal(resolveDest('pages/contact.html', '/'), 'index.html');
});

test('AJAX判定: type="submit" の submit だけでは発火しない（誤warn回避）', () => {
  const html =
    '<form action="/contact"><button type="submit" id="b" data-gtm-event="x">送信</button></form>' +
    '<script>menu.addEventListener("click", (e) => { e.preventDefault(); });</script>';
  assert.equal(rules(scan(html, ok)).includes('ajax-no-conversion'), false);
});

test('button type=button が JS で submit していれば submit-not-button', () => {
  const f = scan('<form data-thankyou="t.html"><input type="email" name="email"><button type="button" onclick="this.form.submit()">送信</button></form>', ok);
  assert.ok(rules(f).includes('submit-not-button'));
});

test('行番号: 前段のタグ数に関わらず正しい行を指す', () => {
  const html = '<div>\n<div>\n<form data-thankyou="t.html"><input type="email" name="email"><button type="submit">x</button></form>';
  const f = scan(html, ok);
  assert.ok(f.some((x) => x.rule === 'submit-missing-tracking' && x.ln === 3));
});

// --- preset: wordpress ---

const wp = { ...ok, config: { presets: ['wordpress'] } };

test('preset off: CF7 の <input type=submit> は通常のクリック配線ルールで見る', () => {
  const f = scan('<form class="wpcf7-form"><input type="email" name="email"><input type="email" name="email"><input type="submit"></form>', ok);
  assert.ok(rules(f).includes('submit-missing-tracking'));
  assert.equal(rules(f).includes('wp-form-no-success-tracking'), false);
});

test('CF7: 完了イベント配線が無いと wp-form-no-success-tracking（クリック配線ルールは抑制）', () => {
  const f = scan('<form class="wpcf7-form"><input type="email" name="email"><input type="email" name="email"><input type="hidden" name="_wpcf7" value="1"><input type="submit"></form>', wp);
  assert.ok(rules(f).includes('wp-form-no-success-tracking'));
  assert.equal(rules(f).includes('submit-not-button'), false);
});

test('CF7: wpcf7mailsent + gtag なら指摘なし', () => {
  const html =
    '<form class="wpcf7-form"><input type="email" name="email"><input type="email" name="email"><input type="submit"></form>' +
    '<script>document.addEventListener("wpcf7mailsent",function(e){gtag("event","lead")})</script>';
  assert.deepEqual(rules(scan(html, wp)), []);
});

test('CF7: CV が wpcf7submit に紐付いていれば wp-form-tracking-on-wrong-event', () => {
  const html =
    '<form class="wpcf7-form"><input type="email" name="email"><input type="email" name="email"><input type="submit"></form>' +
    '<script>document.addEventListener("wpcf7submit",function(){gtag("event","lead")})</script>';
  const f = scan(html, wp);
  assert.ok(rules(f).includes('wp-form-tracking-on-wrong-event'));
  assert.equal(f.find((x) => x.rule === 'wp-form-tracking-on-wrong-event').severity, 'warn');
});

test('Snow Monkey: smf.complete が無ければ wp-form-no-success-tracking', () => {
  const f = scan('<form class="snow-monkey-form"><button type="submit">送信</button></form>', wp);
  assert.ok(rules(f).includes('wp-form-no-success-tracking'));
});

test('Snow Monkey: smf.complete + dataLayer.push なら指摘なし', () => {
  const html =
    '<form class="snow-monkey-form"><button type="submit">送信</button></form>' +
    '<script>document.addEventListener("smf.complete",function(e){if(e.detail.status==="complete")dataLayer.push({event:"cv"})})</script>';
  assert.deepEqual(rules(scan(html, wp)), []);
});

test('WP フォームは action 由来の thankyou を誤爆させない', () => {
  const html =
    '<form class="wpcf7-form" action="thanks.html"><input type="submit"></form>' +
    '<script>document.addEventListener("wpcf7mailsent",()=>dataLayer.push({event:"x"}))</script>';
  const f = scan(html, { filename: 'contact.html', exists: () => false, readText: () => null, config: { presets: ['wordpress'] } });
  assert.equal(rules(f).includes('thankyou-unresolved'), false);
});

test('WPForms / MW WP Form は検出のみ（success-tracking は課さない=誤検知回避）', () => {
  const wpf = scan('<form class="wpforms-form"><button type="submit" class="wpforms-submit">送信</button></form>', wp);
  assert.equal(rules(wpf).includes('wp-form-no-success-tracking'), false);
  const mw = scan('<form class="mw_wp_form"><input type="submit" name="submitSend" value="送信"></form>', wp);
  assert.equal(rules(mw).includes('submit-not-button'), false); // 検出→クリック配線ルール抑制
  assert.equal(rules(mw).includes('wp-form-no-success-tracking'), false);
});

// --- preset: meta ---

const meta = { ...ok, config: { presets: ['meta'] } };

test('Meta: fbq(track) があるのに base code が無いと meta-pixel-track-without-base (error)', () => {
  const html =
    '<form action="/s.php"><input type="email" name="email"><input type="email" name="email"><button type="submit" id="b" data-gtm-event="x">送信</button></form>' +
    '<script>fbq("track","Lead")</script>';
  const f = scan(html, meta);
  const hit = f.find((x) => x.rule === 'meta-pixel-track-without-base');
  assert.ok(hit);
  assert.equal(hit.severity, 'error');
});

test('Meta: 異なる PIXEL_ID で init が複数なら meta-pixel-duplicate-init (warn)', () => {
  const html =
    '<form action="/s.php"><input type="email" name="email"><input type="email" name="email"><button type="submit" id="b" data-gtm-event="x">送信</button></form>' +
    '<script>fbq("init","111111111111111");fbq("init","222222222222222");fbq("track","PageView")</script>';
  const f = scan(html, meta);
  const hit = f.find((x) => x.rule === 'meta-pixel-duplicate-init');
  assert.ok(hit);
  assert.equal(hit.severity, 'warn');
});

test('Meta: init + track が揃っていれば meta 指摘なし', () => {
  const html =
    '<form action="/s.php"><input type="email" name="email"><input type="email" name="email"><button type="submit" id="b" data-gtm-event="x">送信</button></form>' +
    '<script>fbq("init","111111111111111");fbq("track","Lead")</script>';
  assert.equal(rules(scan(html, meta)).some((r) => r.startsWith('meta-')), false);
});

test('preset 未指定なら fbq/CF7 マークアップがあっても新ルールは沈黙（後方互換）', () => {
  const html =
    '<form class="wpcf7-form" data-thankyou="t.html"><button type="submit" id="s" data-gtm-event="x">送信</button></form>' +
    '<script>fbq("track","Lead")</script>';
  const f = scan(html, ok);
  assert.equal(rules(f).some((r) => r.startsWith('wp-form-') || r.startsWith('meta-')), false);
});

// --- 計測基盤の有無によるゲート（実データ監査 2026-07 由来） ---
// 公開HTML 783本のうち、計測タグが1つも無いページは 754本。そこに「コンバージョンが
// 計測できない」と言っても意味がなく、v0.3.0 はその 444本を error で落としていた。

const noMeasure = { exists: () => true, readText: () => '<meta name="robots" content="noindex">' };

test('計測基盤が皆無なら、配線系ルール（missing-tracking / ajax-no-conversion）は黙る', () => {
  const html =
    '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit">送信</button></form>' +
    '<script>form.addEventListener("submit",e=>{e.preventDefault();fetch("/x")})</script>';
  const f = scan(html, noMeasure);
  assert.equal(rules(f).includes('submit-missing-tracking'), false);
  assert.equal(rules(f).includes('ajax-no-conversion'), false);
});

test('同じHTMLでも GTM が入っていれば配線の欠落を指摘する', () => {
  const html =
    '<script>(function(w,d){w.dataLayer=w.dataLayer||[]})(window,document)</script>' +
    '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit">送信</button></form>';
  assert.ok(rules(scan(html, noMeasure)).includes('submit-missing-tracking'));
});

test('gtag / fbq / analytics.track のいずれでも「計測している」と判定する', () => {
  const form = '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit">送信</button></form>';
  for (const snippet of ['<script>gtag("config","G-X")</script>', '<script>fbq("init","1")</script>', '<script>analytics.track("x")</script>']) {
    assert.ok(rules(scan(snippet + form, noMeasure)).includes('submit-missing-tracking'), snippet);
  }
});

test('measures を明示すればファイル内容に関わらずそれに従う（CLIがプロジェクト全体で判定するため）', () => {
  const html = '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit">送信</button></form>';
  assert.ok(rules(scan(html, { ...noMeasure, measures: true })).includes('submit-missing-tracking'));
  const withGtm = '<script>dataLayer.push({})</script>' + html;
  assert.equal(rules(scan(withGtm, { ...noMeasure, measures: false })).includes('submit-missing-tracking'), false);
});

test('計測が皆無でも、サンクスページの解決不能は指摘し続ける（計測と無関係の実バグ）', () => {
  const f = scan('<form action="/thanks.html"><input type="email" name="email"><input type="submit"></form>', {
    exists: () => false,
    readText: () => null,
  });
  assert.ok(rules(f).includes('thankyou-unresolved'));
});

// --- 検索/絞り込みフォームの除外（実データ監査 2026-07 由来） ---
// Tranducvu1/Web・Admin の「From/To/Subject + Search」は管理画面の絞り込みUIであって
// コンバージョンではない。連絡先を集めていないフォームは配線ルールの対象外にする。

test('検索・絞り込みフォームには「計測できない」と言わない', () => {
  const html =
    '<script>dataLayer.push({})</script>' +
    '<form><input class="form-control" type="text"><button class="btn">Search</button></form>';
  assert.equal(rules(scan(html, ok)).includes('submit-missing-tracking'), false);
});

test('ボタンの文言では判定しない（「空室を検索」でも連絡先を集めていれば対象）', () => {
  const html =
    '<script>dataLayer.push({})</script>' +
    '<form data-thankyou="t.html"><input type="tel" name="tel"><button type="submit">空室を検索</button></form>';
  assert.ok(rules(scan(html, ok)).includes('submit-missing-tracking'));
});

test('textarea があるフォームは問い合わせ扱い', () => {
  const html =
    '<script>gtag("config","G-X")</script>' +
    '<form data-thankyou="t.html"><textarea></textarea><button type="submit">送る</button></form>';
  assert.ok(rules(scan(html, ok)).includes('submit-missing-tracking'));
});

test('同一ページに検索フォームと問い合わせフォームがあれば、問い合わせ側だけ指摘する', () => {
  const html =
    '<script>dataLayer.push({})</script>' +
    '<form><input type="text" class="q"><button>Search</button></form>' +
    '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit">送信</button></form>';
  const f = scan(html, ok);
  const hits = f.filter((x) => x.rule === 'submit-missing-tracking');
  assert.equal(hits.length, 1);
});

// --- 実データ監査で残った本物（回帰ガード・2026-07 / 公開リポジトリ 1,380本） ---
// 誤検知を消す修正で、この5形をうっかり黙らせないための固定。

const realWorld = [
  ['oooAHOYooo/contact.html', '<button type="submit" class="submit-btn">Send Message →</button>'],
  ['bw-weight-lifting-journal/contact.html', '<input type="submit" value="Submit" />'],
  ['KnownAim11/Home.jsx', '<button type="submit" class="form-button">Check Availability & Price</button>'],
  ['Mayank77maruti/indexBOQ.html', '<button class="btn btn-primary" onclick="submitEmail()">Send To Email</button>'],
  ['ashaychangwani/form.html', '<input type="submit" value="Next" name="next" class="submitButton">'],
];

for (const [label, control] of realWorld) {
  test(`実データ: ${label} の計測されない送信は検出し続ける`, () => {
    const html =
      '<script>dataLayer.push({})</script>' +
      `<form data-thankyou="t.html"><input type="email" name="email">${control}</form>`;
    assert.ok(rules(scan(html, ok)).includes('submit-missing-tracking'), control);
  });
}

// --- 見逃しの監査（2026-08） ---
// 別のモデルに「このスキャナを黙らせるマークアップ」を作らせ、実際に通したもの。
// 12件のうち本物は3件で、残りは設計どおり（フレームワークの中身は静的に見えない）か
// 指摘そのものが誤りだった。重かったのは「見えなかった」を「問題なし」と報告する形。

test('送信コントロールが1つも見つからないフォームは、黙って通さない', () => {
  // <SubmitButton> が何を描画するかは静的には分からない。分からないことを
  // 「tracking wired」と報告するのが一番まずい。warn で言う。
  const html =
    '<script>dataLayer.push({})</script>' +
    '<form data-thankyou="t.html"><input type="email" name="email"><SubmitButton>送信</SubmitButton></form>';
  assert.ok(rules(scan(html, ok)).includes('submit-control-not-found'));
});

test('送信コントロールが見えているフォームでは、その warn を出さない', () => {
  const html =
    '<script>dataLayer.push({})</script>' +
    '<form data-thankyou="t.html"><input type="email" name="email"><button type="submit" id="go" data-gtm-event="lead">送信</button></form>';
  assert.deepEqual(rules(scan(html, ok)), []);
});

test('JSX の定数式で書かれた type も送信コントロールとして読む', () => {
  for (const t of ['{"submit"}', "{'submit'}", '{`submit`}']) {
    const html =
      '<script>dataLayer.push({})</script>' +
      `<form data-thankyou="t.html"><input type="email" name="email"/><button type=${t}>送信</button></form>`;
    const r = rules(scan(html, ok));
    assert.ok(r.includes('submit-missing-tracking'), `type=${t} が送信ボタンとして読めていない`);
    assert.ok(!r.includes('submit-control-not-found'), `type=${t} で「見つからない」になっている`);
  }
});

test('補間を含む式は定数として読まない（実行時の値は分からないままにする）', () => {
  const html =
    '<script>dataLayer.push({})</script>' +
    '<form data-thankyou="t.html"><input type="email" name="email"/><button type="submit" id={`btn-${i}`}>送信</button></form>';
  assert.ok(rules(scan(html, ok)).includes('submit-dynamic-id'));
});

// コメントは書いてあるだけで、実行されない。
//
// 計測基盤の有無もコンバージョン呼び出しの有無も生テキストで見ていたので、
// 「うちは gtag を使っていない」と注記した人だけが配線ルールを全部有効化されて
// 怒られ、逆に「ここで gtag を呼ぶな」というコメントは本物の呼び出しとして数えられて
// 本当に未配線のフォームが黙っていた。どちらも言及を実行として読んだ結果。
test('HTML コメントの中の gtag は計測基盤ではない', () => {
  const html = '<!-- This site intentionally does not call gtag() or load Google Analytics. -->';
  assert.equal(/gtag\s*\(/.test(stripComments(html)), false);
});

test('JS コメントの中の gtag はコンバージョン呼び出しではない', () => {
  const html = '<script>\n// gtag must never be called here; not implemented yet.\n</script>';
  assert.equal(stripComments(html).includes('gtag'), false);
});

test('本物の呼び出しは残る（消しすぎると配線ルールが黙る方向に壊れる）', () => {
  const html = '<script>\ngtag("event", "generate_lead");\n</script>';
  assert.equal(stripComments(html).includes('gtag'), true);
});

test('protocol-relative な //cdn URL をコメントとして食わない', () => {
  const html = '<script src="//www.googletagmanager.com/gtm.js"></script>';
  assert.equal(stripComments(html).includes('googletagmanager'), true);
});

test('https:// の // もコメントではない', () => {
  const html = '<script>\nconst u = "https://www.googletagmanager.com/gtm.js";\n</script>';
  assert.equal(stripComments(html).includes('googletagmanager'), true);
});

test('コメントを空白化しても行番号がずれない', () => {
  const html = '<!--\na\nb\n-->\n<form></form>';
  assert.equal(stripComments(html).split('\n').length, html.split('\n').length);
});
