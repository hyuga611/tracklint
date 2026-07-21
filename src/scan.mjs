// tracklint — conversion-tracking integrity linter (pure core).
//
// 「フォーム / CTA が計測に配線されているか」を HTML/JSX ソースから静的に検証する。
// 表示は正常なのに計測だけ静かに壊れる—を PR 時点で落とす。依存ゼロ・言語非依存。
//
// このファイルは副作用ゼロの純粋関数だけを公開する（fs/network は check.mjs 側で注入）。

export const DEFAULT_CONFIG = {
  // 明示的な「計測フック」とみなす属性（provider を足すだけで自社トラッカにも対応）
  trackingAttributes: ['data-gtm-event', 'data-ga4-event', 'data-track'],
  // 「コンバージョンが飛んだ」とみなす JS 呼び出し
  conversionCalls: ['dataLayer.push', 'gtag', 'analytics.track'],
  // 有効化するプリセット（フォームフレームワーク/計測基盤ごとの知識）: 'wordpress' | 'meta'
  presets: [],
  // ルールごとの severity: 'error' | 'warn' | 'off'
  rules: {
    'submit-not-button': 'error',
    'submit-missing-tracking': 'error',
    'submit-dynamic-id': 'warn',
    'submit-duplicate-id': 'error',
    'submit-missing-gtm-event-attr': 'off', // ノイズ抑制のため既定 off
    'ajax-no-conversion': 'warn', // 誤検知が出やすいので既定 warn
    'thankyou-unresolved': 'error',
    'thankyou-indexable': 'error',
    // preset:wordpress（該当フォーム検出時のみ発火）
    'wp-form-no-success-tracking': 'warn',
    'wp-form-tracking-on-wrong-event': 'warn',
    // preset:meta（fbq 検出時のみ発火）
    'meta-pixel-track-without-base': 'error',
    'meta-pixel-duplicate-init': 'warn',
  },
};

// ---- tokenizer（ゼロ依存・行番号付き。JSX の {expr} 属性値も許容） ----

// タグ属性部は「クオート文字列」「{JSX式}（1段ネストまで）」「その他非区切り文字」を許容する。
// これにより onClick={() => f()} の中の '>' や data-x={a > b} でタグが途中終了しない。
const BRACE = String.raw`\{(?:[^{}]|\{[^{}]*\})*\}`;
const TAG = new RegExp(String.raw`<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|${BRACE}|[^"'>])*)>`, 'g');
const ATTR = new RegExp(String.raw`([\w:@.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(${BRACE})|([^\s"'=<>\`]+)))?`, 'g');

// HTML コメントと <script>/<style> 本文を「長さ・改行を保ったまま」空白化する。
// これで行番号やオフセットを狂わせずに、コメント/スクリプト内のタグ的テキストを走査対象から外せる。
const COMMENT = /<!--[\s\S]*?-->/g;
const RAWTEXT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const blank = (m) => m.replace(/[^\n]/g, ' ');

function parseAttrs(str) {
  const attrs = new Map();
  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(str)) !== null) {
    if (!m[1]) continue;
    const name = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
    if (!attrs.has(name)) attrs.set(name, val);
  }
  return attrs;
}

/** HTML/JSX をタグ列に分解する（コメント・<script>/<style> 本文・doctype は無視される）。 */
export function tokenize(html) {
  const clean = html.replace(COMMENT, blank).replace(RAWTEXT, blank);
  const tokens = [];
  let m;
  let pos = 0;
  let line = 1;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(clean)) !== null) {
    while (pos < m.index) {
      if (clean.charCodeAt(pos) === 10) line++;
      pos++;
    }
    let attrStr = m[3];
    // 自己終了 '/' の誤検出を避ける: 直前が空白/クオート、または属性部先頭のときだけ自己終了とみなす
    // （action=/thanks/ のような未クオート値の末尾スラッシュを自己終了と誤認しない）。
    const selfClose = /(?:^|[\s"'`])\/\s*$/.test(attrStr);
    if (selfClose) attrStr = attrStr.replace(/\/\s*$/, '');
    tokens.push({
      name: m[2].toLowerCase(),
      isClose: m[1] === '/',
      selfClose,
      attrs: parseAttrs(attrStr),
      line,
    });
  }
  return tokens;
}

const isDynamic = (v) => /\{|<\?|\$\{|%[sd]|\{\{/.test(v);

/** 静的で一意判定に使える id を集める（動的 id は除外）。check.mjs の重複検出用。 */
export function collectIds(html) {
  const ids = [];
  for (const t of tokenize(html)) {
    if (t.isClose) continue;
    const id = t.attrs.get('id');
    if (id && !isDynamic(id)) ids.push(id);
  }
  return ids;
}

/** サンクスページの <head> に noindex meta があるか。 */
export function hasNoindex(html) {
  for (const t of tokenize(html)) {
    if (t.name !== 'meta' || t.isClose) continue;
    const name = (t.attrs.get('name') || '').toLowerCase();
    const content = t.attrs.get('content') || '';
    if ((name === 'robots' || name === 'googlebot') && /\b(noindex|none)\b/i.test(content)) return true;
  }
  return false;
}

// ---- パス解決（fromFile からの相対 / ルート絶対 → リポジトリ相対パス） ----

export function resolveDest(fromFile, dest) {
  let d = String(dest).split(/[?#]/)[0].trim();
  if (!d) return null;
  if (/^(?:[a-z][\w+.-]*:)?\/\//i.test(d) || /^(?:mailto|tel):/i.test(d) || d.startsWith('#')) return null;
  const endsSlash = d.endsWith('/');
  let rel;
  if (d.startsWith('/')) rel = d.slice(1);
  else {
    const dir = fromFile.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
    rel = fromFile.includes('/') ? `${dir}/${d}` : d;
  }
  const parts = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  let out = parts.join('/');
  const base = out.split('/').pop() || '';
  if (endsSlash || !/\.[a-z0-9]+$/i.test(base)) {
    out = out ? `${out}/index.html` : 'index.html';
  }
  return out;
}

// ---- rules ----

function submitControl(form) {
  // 優先: 正しい <button type=submit> → だめな送信要素（input submit/image, JSで submit するボタン/div 等）
  let proper = null;
  let improper = null;
  for (const c of form.controls) {
    const onclick = c.attrs.get('onclick') || '';
    const jsSubmits = /\.(?:request)?submit\s*\(/i.test(onclick);
    if (c.name === 'button') {
      const type = (c.attrs.get('type') || 'submit').toLowerCase();
      if (type === 'submit') {
        if (!proper) proper = c;
      } else if (jsSubmits && !improper) {
        improper = c; // type=button/reset なのに JS でフォームを submit している
      }
    } else if (c.name === 'input') {
      const type = (c.attrs.get('type') || '').toLowerCase();
      if (type === 'submit' || type === 'image') {
        if (!improper) improper = c;
      } else if (jsSubmits && !improper) {
        improper = c;
      }
    } else if (jsSubmits && !improper) {
      improper = c; // div/span/a が onclick で form を submit している
    }
  }
  return { proper, improper };
}

// ---- WordPress フォームプリセット（公式ドキュメントで裏取りした完了シグナル） ----
//
// 各フォームプラグインの「送信完了」挙動は異なり、既定では別URLのサンクスへ遷移しない。
// そのため generic な thankyou 判定が誤爆する（＝presetが要る核心理由）。ここでは
//  - CF7 / Snow Monkey: 完了 DOM イベントに計測が配線されているかを静的に検証する
//  - WPForms / MW WP Form: 完了がサーバ再描画/設定依存で静的検証できない → 検出（＝誤爆抑制）のみ
const cls = (t) => t.attrs.get('class') || '';
const hasControlName = (form, name) =>
  form.controls.some((c) => c.name === 'input' && (c.attrs.get('name') || '') === name);

const WP_FORM_TYPES = [
  {
    key: 'cf7',
    name: 'Contact Form 7',
    model: 'event', // 既定AJAX・同一URL・完了はDOMイベント（公式: 別サンクス遷移は不要）
    match: (f) => /\bwpcf7-form\b/.test(cls(f)) || hasControlName(f, '_wpcf7'),
    signals: ['wpcf7mailsent'], // メール送信成功時のみ発火＝CVに使う正しいイベント
    wrong: ['wpcf7submit'], // 「他の事象に関わらず毎回発火」＝invalid/spam/failedでもCV水増し
  },
  {
    key: 'smf',
    name: 'Snow Monkey Forms',
    model: 'event',
    match: (f) => /\bsnow-monkey-form\b/.test(cls(f)),
    signals: ['smf.complete'], // detail.status==='complete' で判定するのが正（smf.submit は全応答で発火）
    wrong: [],
  },
  {
    key: 'wpforms',
    name: 'WPForms',
    model: 'detect', // 確認タイプ3種・完了はDOM置換/設定依存で静的検証不能 → 検出のみ
    match: (f) => /\bwpforms-form\b/.test(cls(f)),
    signals: [],
    wrong: [],
  },
  {
    key: 'mwwp',
    name: 'MW WP Form',
    model: 'detect', // JSイベント無し・完了は同一URL再描画/別URL設定依存 → 検出のみ
    match: (f) => hasControlName(f, 'submitSend') || hasControlName(f, 'submitConfirm'),
    signals: [],
    wrong: [],
  },
];

function detectWpForm(form) {
  for (const t of WP_FORM_TYPES) if (t.match(form)) return t;
  return null;
}

/**
 * 1ファイル分の HTML/JSX を走査して findings を返す（純粋・テスト可能）。
 * @param opts.filename    リポジトリ相対のファイル名（パス解決に使う）
 * @param opts.exists      `(relPath) => boolean` サンクスページの実在判定
 * @param opts.readText    `(relPath) => string|null` サンクスページ本文の取得
 * @param opts.isDupId     `(id) => boolean` id がファイル横断で重複しているか
 * @param opts.config      設定（DEFAULT_CONFIG にマージ済み）
 */
export function scan(html, opts = {}) {
  const {
    filename = '',
    exists = () => true,
    readText = () => null,
    isDupId = () => false,
    config = DEFAULT_CONFIG,
  } = opts;
  const rules = { ...DEFAULT_CONFIG.rules, ...(config.rules || {}) };
  const trackingAttributes = config.trackingAttributes || DEFAULT_CONFIG.trackingAttributes;
  const presets = new Set(config.presets || []);
  const wordpressActive = presets.has('wordpress') || presets.has('wp');
  const metaActive = presets.has('meta');
  let conversionCalls = config.conversionCalls || DEFAULT_CONFIG.conversionCalls;
  // Meta / WordPress を有効化したら fbq を「コンバージョン呼び出し」として認識する
  if (metaActive || wordpressActive) conversionCalls = [...conversionCalls, 'fbq'];

  const findings = [];
  const push = (rule, ln, msg) => {
    const severity = rules[rule] ?? 'error';
    if (severity === 'off') return;
    findings.push({ ln, rule, severity, msg });
  };

  // フォームのスコープを組み立てる
  const tokens = tokenize(html);
  const forms = [];
  const stack = [];
  for (const t of tokens) {
    if (t.name === 'form' && !t.isClose && !t.selfClose) {
      const f = { line: t.line, attrs: t.attrs, controls: [] };
      stack.push(f);
      forms.push(f);
    } else if (t.name === 'form' && t.isClose) {
      stack.pop();
    } else if (stack.length && !t.isClose && ['button', 'input', 'div', 'span', 'a'].includes(t.name)) {
      stack[stack.length - 1].controls.push(t);
    }
  }

  // ファイル単位の signal（R3 用）。コメントは除外し、AJAX の判定は
  // 「実際の submit ハンドラの証拠」に限定する（type="submit" 属性の "submit" に反応しない）。
  const code = html.replace(COMMENT, ' ');
  const hasSubmitHandler = /addEventListener\s*\(\s*['"]submit['"]|onsubmit\s*=|\.(?:request)?submit\s*\(/i.test(code);
  const hasAjax =
    /\bfetch\s*\(|XMLHttpRequest|\baxios\b|\$\.ajax|\.ajax\s*\(/.test(code) ||
    (/preventDefault\s*\(/.test(code) && hasSubmitHandler);
  const hasConversion = conversionCalls.some((c) => code.includes(c));

  let sawWpForm = false;
  for (const form of forms) {
    const wp = wordpressActive ? detectWpForm(form) : null;
    if (wp) sawWpForm = true;

    // R1 / R2: 送信コントロール（WP フォームは完了イベントで計測するため、クリック配線ルールは適用しない）
    const { proper, improper } = submitControl(form);
    if (!wp && improper && !proper) {
      const what =
        improper.name === 'input'
          ? `<input type="${(improper.attrs.get('type') || '').toLowerCase()}">`
          : `<${improper.name}>`;
      push('submit-not-button', improper.line, `送信コントロールが ${what} です。<button type="submit"> にしてください（GTM/GA4 のクリック計測が要素を特定できません）`);
    } else if (!wp && proper) {
      const id = proper.attrs.get('id');
      const hasId = id != null && id !== '';
      const hasTrackAttr = trackingAttributes.some((a) => proper.attrs.has(a) && proper.attrs.get(a) !== '');
      const onclick = proper.attrs.get('onclick') || '';
      const inlineConv = conversionCalls.some((c) => onclick.includes(c));
      if (!hasId && !hasTrackAttr && !inlineConv) {
        push('submit-missing-tracking', proper.line, '送信ボタンに一意の id・計測属性(data-gtm-event 等)・インライン計測呼び出しがありません（クリックが計測不能）');
      } else if (hasId && isDynamic(id)) {
        push('submit-dynamic-id', proper.line, `送信ボタンの id がテンプレート展開されています("${id}")。実行時の値・一意性を静的に検証できません`);
      } else if (hasId && isDupId(id)) {
        push('submit-duplicate-id', proper.line, `送信ボタンの id "${id}" が複数箇所で使われています。クリックが二重計上/取り違えられます`);
      }
      if (hasId && !hasTrackAttr) {
        push('submit-missing-gtm-event-attr', proper.line, 'id はありますが data-gtm-event が無く、コンバージョン名が GTM コンテナ側にしか存在しません');
      }
    }

    // R4: サンクスページ（WP フォームの action は admin-ajax 等で静的サンクスではない → action 由来では推定しない）
    let dest = form.attrs.get('data-thankyou') || form.attrs.get('data-success-url');
    if (!dest && !wp) {
      const action = (form.attrs.get('action') || '').split(/[?#]/)[0];
      if (action && !/^(?:[a-z][\w+.-]*:)?\/\//i.test(action)) {
        const base = (action.replace(/\/$/, '').split('/').pop()) || '';
        const ext = (base.match(/\.([a-z0-9]+)$/i) || [])[1];
        if (!ext || /^html?$/i.test(ext)) dest = action; // ページ or ディレクトリ（.php 等のハンドラは静的に追えないのでスキップ）
      }
    }
    if (dest) {
      const resolved = resolveDest(filename, dest);
      if (resolved) {
        if (!exists(resolved)) {
          push('thankyou-unresolved', form.line, `サンクスページ "${dest}" (${resolved}) がリポジトリに存在しません`);
        } else {
          const body = readText(resolved);
          if (body != null && !hasNoindex(body)) {
            push('thankyou-indexable', form.line, `サンクスページ "${dest}" に <meta name="robots" content="noindex"> がありません（インデックス漏れ・CV 二重計上のリスク）`);
          }
        }
      }
    }

    // preset:wordpress — CF7 / Snow Monkey は「完了イベントに計測が配線されているか」を検証する
    if (wp && wp.model === 'event') {
      const hasSignal = wp.signals.some((s) => code.includes(s));
      if (!hasSignal || !hasConversion) {
        const why = !hasSignal
          ? `'${wp.signals[0]}' のリスナが見当たりません`
          : '成功時の計測呼び出し(gtag / dataLayer.push / fbq)が見当たりません';
        push('wp-form-no-success-tracking', form.line, `${wp.name} は送信完了でページ遷移しません。'${wp.signals[0]}' のリスナ内で計測を発火してください（${why}）`);
      }
      if (wp.wrong.length && hasConversion) {
        const hasWrong = wp.wrong.some((w) => code.includes(w));
        const hasRight = wp.signals.some((s) => code.includes(s));
        if (hasWrong && !hasRight) {
          push('wp-form-tracking-on-wrong-event', form.line, `計測が '${wp.wrong[0]}' に紐付いています（無効送信・スパム時も発火し CV を水増しします）。成功時のみ発火する '${wp.signals[0]}' を使ってください`);
        }
      }
    }
    // wp.model === 'detect'（WPForms / MW WP Form）は完了がサーバ再描画/設定依存で静的検証不能。
    // 検出＝thankyou 誤爆の抑制のみ行い、success-tracking は課さない（誤検知回避）。
  }

  // R3: AJAX 送信なのに成功時の計測イベントが無い（ファイル単位・1回だけ）
  //   WP フォーム検出時は、より具体的な wp-form-* ルールに委ねて二重警告を避ける
  if (forms.length && hasAjax && !hasConversion && !(wordpressActive && sawWpForm)) {
    push('ajax-no-conversion', forms[0].line, `AJAX 送信のようですが、成功時の計測呼び出し(${conversionCalls.join(' / ')})がファイル内に見当たりません（ページ遷移しないため計測が飛びません）`);
  }

  // preset:meta — Meta Pixel(fbq) の静的配線チェック（fbq が無ければ何も出さない）
  if (metaActive) {
    const initIds = [...code.matchAll(/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/g)].map((m) => m[1]);
    const distinctIds = [...new Set(initIds)];
    const hasTrack = /fbq\s*\(\s*['"]track(?:Custom)?['"]/.test(code);
    const hasBase = /fbevents\.js/.test(code) || /fbq\s*\(\s*['"]init['"]/.test(code);
    const anchor = forms[0] ? forms[0].line : 1;
    if (hasTrack && !hasBase) {
      push('meta-pixel-track-without-base', anchor, `fbq('track', …) がありますが Meta Pixel の base code（fbq('init', …) / fbevents.js ローダー）が見当たりません（track がキューに積まれるだけで送信されません）`);
    }
    if (distinctIds.length > 1) {
      push('meta-pixel-duplicate-init', anchor, `異なる Meta Pixel ID で fbq('init') が複数あります(${distinctIds.join(', ')})。PageView/CV が二重計上されます`);
    }
  }

  return findings.sort((a, b) => a.ln - b.ln);
}
