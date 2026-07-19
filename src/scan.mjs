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
  const conversionCalls = config.conversionCalls || DEFAULT_CONFIG.conversionCalls;

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

  for (const form of forms) {
    // R1 / R2: 送信コントロール
    const { proper, improper } = submitControl(form);
    if (improper && !proper) {
      const what =
        improper.name === 'input'
          ? `<input type="${(improper.attrs.get('type') || '').toLowerCase()}">`
          : `<${improper.name}>`;
      push('submit-not-button', improper.line, `送信コントロールが ${what} です。<button type="submit"> にしてください（GTM/GA4 のクリック計測が要素を特定できません）`);
    } else if (proper) {
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

    // R4: サンクスページ
    let dest = form.attrs.get('data-thankyou') || form.attrs.get('data-success-url');
    if (!dest) {
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
  }

  // R3: AJAX 送信なのに成功時の計測イベントが無い（ファイル単位・1回だけ）
  if (forms.length && hasAjax && !hasConversion) {
    push('ajax-no-conversion', forms[0].line, `AJAX 送信のようですが、成功時の計測呼び出し(${conversionCalls.join(' / ')})がファイル内に見当たりません（ページ遷移しないため計測が飛びません）`);
  }

  return findings.sort((a, b) => a.ln - b.ln);
}
