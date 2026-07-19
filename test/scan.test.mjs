import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, tokenize, hasNoindex, resolveDest, collectIds } from '../src/scan.mjs';

const ok = { exists: () => true, readText: () => '<meta name="robots" content="noindex">' };

function rules(findings) {
  return findings.map((f) => f.rule);
}

test('submit-not-button: <input type=submit> を検出', () => {
  const f = scan('<form><input type="submit" value="送信"></form>', ok);
  assert.ok(rules(f).includes('submit-not-button'));
  assert.equal(f.find((x) => x.rule === 'submit-not-button').severity, 'error');
});

test('submit-not-button: onclick で submit する div を検出', () => {
  const f = scan('<form><div onclick="document.forms[0].submit()">送信</div></form>', ok);
  assert.ok(rules(f).includes('submit-not-button'));
});

test('正しい button type=submit + id + data-gtm-event は指摘しない', () => {
  const f = scan('<form data-thankyou="t.html"><button type="submit" id="s1" data-gtm-event="lead">送信</button></form>', ok);
  assert.deepEqual(rules(f), []);
});

test('submit-missing-tracking: id も計測属性も無い送信ボタン', () => {
  const f = scan('<form data-thankyou="t.html"><button type="submit">送信</button></form>', ok);
  assert.ok(rules(f).includes('submit-missing-tracking'));
});

test('submit-duplicate-id: id が重複していれば error', () => {
  const f = scan('<form data-thankyou="t.html"><button type="submit" id="dup">送信</button></form>', {
    ...ok,
    isDupId: (id) => id === 'dup',
  });
  assert.ok(rules(f).includes('submit-duplicate-id'));
});

test('submit-dynamic-id: テンプレート展開された id は warn', () => {
  const f = scan('<form data-thankyou="t.html"><button type="submit" id="s-{{n}}">送信</button></form>', ok);
  const hit = f.find((x) => x.rule === 'submit-dynamic-id');
  assert.ok(hit);
  assert.equal(hit.severity, 'warn');
});

test('thankyou-unresolved: サンクスページが存在しないと error', () => {
  const f = scan('<form action="thanks.html"><button type="submit" id="s1">送信</button></form>', {
    filename: 'contact.html',
    exists: () => false,
    readText: () => null,
  });
  assert.ok(rules(f).includes('thankyou-unresolved'));
});

test('thankyou-indexable: noindex の無いサンクスページは error', () => {
  const f = scan('<form action="thanks.html"><button type="submit" id="s1">送信</button></form>', {
    filename: 'contact.html',
    exists: () => true,
    readText: () => '<head><title>done</title></head>',
  });
  assert.ok(rules(f).includes('thankyou-indexable'));
});

test('ajax-no-conversion: AJAX 送信で計測呼び出しが無いと warn', () => {
  const html =
    '<form data-thankyou="t.html"><button type="submit" id="s1" data-gtm-event="x">送信</button></form>' +
    '<script>form.addEventListener("submit",e=>{e.preventDefault();fetch("/x")})</script>';
  const f = scan(html, ok);
  const hit = f.find((x) => x.rule === 'ajax-no-conversion');
  assert.ok(hit);
  assert.equal(hit.severity, 'warn');
});

test('ajax: dataLayer.push があれば ajax-no-conversion は出ない', () => {
  const html =
    '<form data-thankyou="t.html"><button type="submit" id="s1" data-gtm-event="x">送信</button></form>' +
    '<script>form.addEventListener("submit",e=>{e.preventDefault();fetch("/x").then(()=>dataLayer.push({event:"x"}))})</script>';
  const f = scan(html, ok);
  assert.equal(rules(f).includes('ajax-no-conversion'), false);
});

test('config.rules で severity を off にできる', () => {
  const html = '<form data-thankyou="t.html"><button type="submit">送信</button></form>';
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
  const f = scan('<form data-thankyou="t.html"><button onClick={() => gtag("event","cv")}>送信</button></form>', ok);
  assert.equal(rules(f).includes('submit-missing-tracking'), false);
});

test('JSX: data-gtm-event が矢印関数の後ろにあっても脱落しない', () => {
  const t = tokenize('<button onClick={() => track()} data-gtm-event="cta">x</button>');
  assert.equal(t[0].attrs.get('data-gtm-event'), 'cta');
});

test('コメントアウトされた壊れフォームは検出しない（false-positive回避）', () => {
  const html =
    '<form data-thankyou="t.html"><button type="submit" id="ok" data-gtm-event="x">送信</button></form>' +
    '<!-- 旧: <form action="old.php"><input type="submit"></form> -->';
  assert.deepEqual(rules(scan(html, ok)), []);
});

test('hasNoindex: コメントアウトされた noindex は無効', () => {
  assert.equal(hasNoindex('<head><!-- <meta name="robots" content="noindex"> --><title>x</title></head>'), false);
});

test('thankyou-indexable: noindexがコメントアウトされていれば検出（false-negative回避）', () => {
  const f = scan('<form action="thanks.html"><button type="submit" id="s1">送信</button></form>', {
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
  const f = scan('<form data-thankyou="t.html"><button type="button" onclick="this.form.submit()">送信</button></form>', ok);
  assert.ok(rules(f).includes('submit-not-button'));
});

test('行番号: 前段のタグ数に関わらず正しい行を指す', () => {
  const html = '<div>\n<div>\n<form data-thankyou="t.html"><button type="submit">x</button></form>';
  const f = scan(html, ok);
  assert.ok(f.some((x) => x.rule === 'submit-missing-tracking' && x.ln === 3));
});
