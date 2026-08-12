#!/usr/bin/env node
// tracklint — conversion-tracking integrity linter (CLI).
//
// 送信ボタン・フォーム・サンクスページが計測に配線されているかを静的に検査し、
// 壊れていれば exit 1 で CI を落とす。依存ゼロ・言語非依存。
// CI(GitHub Action)で毎PR走らせるのが本体。
//
//   node src/check.mjs [file|dir ...]   # 省略時は <form> を含むファイルを自動検出

import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scan, collectIds, DEFAULT_CONFIG, MEASUREMENT } from './scan.mjs';

const EXT = /\.(html?|php|jsx|tsx|vue|svelte)$/i;
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', '.git', '.svn', 'coverage']);

// --preset=wordpress,meta を解釈（= 区切り必須。値が位置引数と衝突しないため空白形式は不可）
function parsePresets(argv) {
  const out = [];
  for (const a of argv) {
    if (a.startsWith('--preset=')) out.push(...a.slice('--preset='.length).split(','));
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

function loadConfig(root, cliPresets = []) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(join(root, 'tracklint.config.json'), 'utf8'));
  } catch {
    cfg = {};
  }
  const presets = [...new Set([...(cfg.presets || []), ...cliPresets])];
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    presets,
    rules: { ...DEFAULT_CONFIG.rules, ...(cfg.rules || {}) },
  };
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(root, full, out);
    } else if (EXT.test(e.name)) {
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('<form')) out.push(relative(root, full).replace(/\\/g, '/'));
    }
  }
}

/** 引数（ファイル/ディレクトリ）を <form> を含む対象ファイル一覧に展開する。 */
export function collectTargets(root, args) {
  const out = [];
  if (args.length === 0) {
    walk(root, root, out);
    return out;
  }
  for (const a of args) {
    const full = resolve(root, a);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).replace(/\\/g, '/'));
  }
  return [...new Set(out)];
}

export function main(argv) {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const root = process.cwd();
  const args = argv.filter((a) => a !== '--' && !a.startsWith('-'));
  const config = loadConfig(root, parsePresets(argv));

  // 明示指定されたパスが存在しない場合は「素通りで exit 0」にせず error にする
  // （files: のタイプミスやリネームで CI が黙って緑になる＝偽の安心を防ぐ）。
  if (args.length) {
    const missing = args.filter((a) => !existsSync(resolve(root, a)));
    if (missing.length) {
      console.error(`tracklint: path not found: ${missing.join(', ')}`);
      return 2;
    }
  }

  const targets = collectTargets(root, args);
  if (targets.length === 0) {
    console.log('tracklint: no file containing a <form> was found — skipping.');
    return 0;
  }

  // 全ファイルを読み、id の重複をファイル横断で集計する
  const texts = new Map();
  for (const f of targets) {
    try {
      texts.set(f, readFileSync(resolve(root, f), 'utf8'));
    } catch {
      console.error(`tracklint: cannot read ${f}`);
      return 2;
    }
  }
  const idCount = new Map();
  for (const t of texts.values()) for (const id of collectIds(t)) idCount.set(id, (idCount.get(id) || 0) + 1);
  const isDupId = (id) => (idCount.get(id) || 0) > 1;

  // 計測基盤がプロジェクトのどこかに存在するか。GTM は共通ヘッダ側に置かれることが多いので、
  // ファイル単位ではなく対象ファイル全体で判定する。1つも無ければ配線系ルールは黙る。
  const measures = [...texts.values()].some((t) => MEASUREMENT.test(t));

  const exists = (p) => existsSync(resolve(root, p));
  const readText = (p) => {
    try {
      return readFileSync(resolve(root, p), 'utf8');
    } catch {
      return null;
    }
  };

  let errors = 0;
  let warns = 0;
  for (const f of targets) {
    const findings = scan(texts.get(f), { filename: f, exists, readText, isDupId, config, measures });
    if (findings.length === 0) {
      console.log(`✓ ${f} — tracking wired`);
      continue;
    }
    const e = findings.filter((x) => x.severity === 'error').length;
    const w = findings.length - e;
    errors += e;
    warns += w;
    console.error(`✗ ${f} — ${findings.length} finding${findings.length === 1 ? '' : 's'} (${e} error / ${w} warning)`);
    for (const x of findings) {
      console.error(`  ${f}:${x.ln}\t[${x.rule}] ${x.msg}`);
      if (inActions) {
        const lvl = x.severity === 'error' ? 'error' : 'warning';
        console.log(`::${lvl} file=${f},line=${x.ln}::[${x.rule}] ${x.msg.replace(/\r?\n/g, ' ')}`);
      }
    }
  }

  // 黙った理由は必ず言う（何も出ないのが「合格」なのか「対象外」なのか分からないのが一番困る）
  if (!measures) {
    console.log(
      `\ntracklint: no analytics found in ${targets.length} file${targets.length === 1 ? '' : 's'} ` +
        `(GTM / gtag / fbq / analytics.track …) — conversion-wiring rules were skipped.`
    );
  }

  if (errors > 0) {
    console.error(`\ntracklint: ${errors} error${errors === 1 ? '' : 's'}${warns ? ` / ${warns} warning${warns === 1 ? '' : 's'}` : ''}`);
    return 1;
  }
  console.log(`\ntracklint: 0 errors${warns ? ` / ${warns} warning${warns === 1 ? '' : 's'}` : ''} — tracking wired`);
  return 0;
}

// 直接実行された時だけ CLI として動く（import 時は関数だけ公開）
//
// argv[1] は「どう呼ばれたか」のパス。`npm i -g` も `npx` もそこにシンボリックリンクを置くので、
// 解決済みの実パスである import.meta.url とは一致せず、install した版の CLI は何もせずに
// exit 0 で終わっていた。リンタにとってこれは最悪の壊れ方で、「問題を見つけなかった」と
// 「一度も動いていない」が区別できない。比較する前にリンクを解決する。
function runDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  if (import.meta.url === pathToFileURL(arg).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (runDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
