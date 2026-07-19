#!/usr/bin/env node
// tracklint — conversion-tracking integrity linter (CLI).
//
// 送信ボタン・フォーム・サンクスページが計測に配線されているかを静的に検査し、
// 壊れていれば exit 1 で CI を落とす。依存ゼロ・言語非依存。
// CI(GitHub Action)で毎PR走らせるのが本体。
//
//   node src/check.mjs [file|dir ...]   # 省略時は <form> を含むファイルを自動検出

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scan, collectIds, DEFAULT_CONFIG } from './scan.mjs';

const EXT = /\.(html?|php|jsx|tsx|vue|svelte)$/i;
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', '.git', '.svn', 'coverage']);

function loadConfig(root) {
  try {
    const cfg = JSON.parse(readFileSync(join(root, 'tracklint.config.json'), 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...cfg,
      rules: { ...DEFAULT_CONFIG.rules, ...(cfg.rules || {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
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
  const config = loadConfig(root);

  // 明示指定されたパスが存在しない場合は「素通りで exit 0」にせず error にする
  // （files: のタイプミスやリネームで CI が黙って緑になる＝偽の安心を防ぐ）。
  if (args.length) {
    const missing = args.filter((a) => !existsSync(resolve(root, a)));
    if (missing.length) {
      console.error(`tracklint: 指定されたパスが見つかりません: ${missing.join(', ')}`);
      return 2;
    }
  }

  const targets = collectTargets(root, args);
  if (targets.length === 0) {
    console.log('tracklint: <form> を含む対象ファイルがありません。スキップ。');
    return 0;
  }

  // 全ファイルを読み、id の重複をファイル横断で集計する
  const texts = new Map();
  for (const f of targets) {
    try {
      texts.set(f, readFileSync(resolve(root, f), 'utf8'));
    } catch {
      console.error(`tracklint: ${f} を読めません`);
      return 2;
    }
  }
  const idCount = new Map();
  for (const t of texts.values()) for (const id of collectIds(t)) idCount.set(id, (idCount.get(id) || 0) + 1);
  const isDupId = (id) => (idCount.get(id) || 0) > 1;

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
    const findings = scan(texts.get(f), { filename: f, exists, readText, isDupId, config });
    if (findings.length === 0) {
      console.log(`✓ ${f} — 計測OK`);
      continue;
    }
    const e = findings.filter((x) => x.severity === 'error').length;
    const w = findings.length - e;
    errors += e;
    warns += w;
    console.error(`✗ ${f} — ${findings.length} 件 (error:${e} warn:${w})`);
    for (const x of findings) {
      console.error(`  ${f}:${x.ln}\t[${x.rule}] ${x.msg}`);
      if (inActions) {
        const lvl = x.severity === 'error' ? 'error' : 'warning';
        console.log(`::${lvl} file=${f},line=${x.ln}::[${x.rule}] ${x.msg.replace(/\r?\n/g, ' ')}`);
      }
    }
  }

  if (errors > 0) {
    console.error(`\ntracklint: ${errors} 件の error${warns ? ` / ${warns} 件の warn` : ''}`);
    return 1;
  }
  console.log(`\ntracklint: error 0 件${warns ? `（warn ${warns} 件）` : ''} — OK`);
  return 0;
}

// 直接実行された時だけ CLI として動く（import 時は関数だけ公開）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
