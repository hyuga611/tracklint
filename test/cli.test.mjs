/**
 * tracklint used to treat an unrecognised `--flag` as a path to scan.
 *
 * It did not go silent here, but it produced a message about a path nobody had
 * asked about, from a tool whose job is to explain things. The operator cannot tell a
 * refusal from a broken tool, so they stop trusting either.
 *
 * There was also no `--help` and no `--version`, which is the first thing anyone
 * types after installing.
 *
 * Found by installing the published package and typing `--help`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname は Node 20.11 で入ったもので、18 では undefined。
// package.json は engines ">=18" と宣言しているのに、この1行でテストファイルごと
// ERR_INVALID_ARG_TYPE で落ちていた。src/ は使っていないので公開物は 18 でも動く。
const HERE = dirname(fileURLToPath(import.meta.url));

const CLI = resolve(HERE, '..', 'src', 'check.mjs');

function run(args, cwd) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

const empty = () => mkdtempSync(join(tmpdir(), 'tracklint-cli-'));

test('an unknown option is refused rather than taken as a path', () => {
  const dir = empty();
  try {
    const r = run(['--zzz-not-a-flag'], dir);
    assert.equal(r.code, 2, 'exit 2 is "could not run", distinct from 0 "nothing to fix"');
    assert.match(r.err, /unknown option --zzz-not-a-flag/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--help prints usage and exits 0', () => {
  const dir = empty();
  try {
    for (const flag of ['--help', '-h']) {
      const r = run([flag], dir);
      assert.equal(r.code, 0, flag);
      assert.match(r.out, /^tracklint \d+\.\d+\.\d+ /, `${flag} must name the tool and its version`);
      assert.match(r.out, /exit 0/, `${flag} must say what the exit codes mean`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--version prints the version in package.json, not a constant that drifts', async () => {
  const dir = empty();
  try {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'));
    for (const flag of ['--version', '-v']) {
      const r = run([flag], dir);
      assert.equal(r.code, 0, flag);
      assert.equal(r.out.trim(), pkg.version, flag);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The other half. A tool that refuses a flag it should accept is no better than one
 * that swallows a flag it should refuse — and this is the direction that gets the
 * whole step deleted from CI.
 */
test('a bare run with no arguments is unaffected', () => {
  const dir = empty();
  try {
    const r = run([], dir);
    assert.equal(r.code, 0, 'nothing to check is not a failure');
    assert.doesNotMatch(r.err, /unknown option/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 自動検出は `text.includes('<form')` で大小を区別していた。`<FORM>` は古いテンプレートに
// 実在し、混在したディレクトリでは「1 file を見た、0 errors」と出て、見ていない方の
// 存在ごと消えていた。検査していないことを検査に通ったと報告する形。
test('auto-discovery finds a form written in uppercase', () => {
  const dir = empty();
  try {
    writeFileSync(
      join(dir, 'upper.html'),
      '<script>dataLayer.push({})</script>\n<FORM data-thankyou="t.html"><INPUT TYPE="email" NAME="email"><BUTTON TYPE="submit">送信</BUTTON></FORM>',
    );
    let out = '';
    try {
      out = execFileSync(process.execPath, [CLI, dir], { encoding: 'utf8' });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
    }
    assert.doesNotMatch(out, /no file containing a <form> was found/);
    assert.match(out, /submit-missing-tracking/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 0.6.0 で submit-control-not-found を足して「黙る」のはやめたのに、締めの一行は
// errors が 0 でありさえすれば "tracking wired" と言い続けていた。警告が
// 「この送信コントロールは確認できない」と言っている同じ出力の最後で、要約が
// 「配線されている」と打ち消す状態で、直そうとした形そのものが残っていた。
// 1 warning が出ていること自体も見ているので、警告が出なくなればこのテストは落ちる。
test('a form whose submit control cannot be seen is not summarised as "tracking wired"', () => {
  const dir = empty();
  try {
    writeFileSync(
      join(dir, 'anchor.html'),
      '<script>window.dataLayer = window.dataLayer || [];</script>\n' +
        '<form><input type="email" name="email"><a href="#" role="button">送信</a></form>',
    );
    const r = run(['anchor.html'], dir);
    assert.equal(r.code, 0, 'a warning must not fail the build');
    assert.match(r.out, /0 errors \/ 1 warning/, 'the unseen submit control must still be reported');
    assert.doesNotMatch(r.out, /tracking wired/, 'what was not checked must not be summarised as wired');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
