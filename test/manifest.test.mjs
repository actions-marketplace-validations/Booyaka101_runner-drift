import test from 'node:test';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { parseManifest, lookupTool, manifestUrl } from '../src/manifest.mjs';
import { readFixture, loadFixtureManifest } from './helpers.mjs';

test('parses the header of a real Ubuntu 22.04 manifest', async () => {
  const m = parseManifest(await readFixture('ubuntu-22.04'), 'ubuntu-22.04');
  assert.equal(m.osVersion, '22.04.5 LTS');
  assert.equal(m.imageVersion, '20260720.234.2');
  assert.equal(m.title, 'Ubuntu 22.04');
});

test('parses both installed-software line styles', async () => {
  const m = parseManifest(await readFixture('ubuntu-22.04'));
  // "- CMake 3.31.6"  (name + single version)
  assert.deepEqual(m.tools.CMake, ['3.31.6']);
  // "- Clang: 13.0.1, 14.0.0, 15.0.7"  (name + colon + version list)
  assert.deepEqual(m.tools.Clang, ['13.0.1', '14.0.0', '15.0.7']);
  assert.deepEqual(m.tools.Python, ['3.10.12']);
  assert.deepEqual(m.tools['Node.js'], ['22.23.1']);
  assert.deepEqual(m.tools.Git, ['2.54.0']);
  assert.deepEqual(m.tools['Docker Client'], ['28.0.4']);
  assert.deepEqual(m.tools['GNU C++'], ['10.5.0', '11.4.0', '12.3.0']);
});

test('keeps a trailing note out of the version', async () => {
  const m = parseManifest(await readFixture('ubuntu-22.04'));
  // "- AzCopy 10.32.4 - available by `azcopy` and `azcopy10` aliases"
  assert.deepEqual(m.tools.AzCopy, ['10.32.4']);
  // "- Bash 5.1.16(1)-release" keeps its suffix
  assert.deepEqual(m.tools.Bash, ['5.1.16(1)-release']);
});

test('the host CMake wins over the Android SDK CMake package', async () => {
  const m = parseManifest(await readFixture('ubuntu-22.04'));
  // The Android table also lists "CMake | 3.18.1<br>3.22.1<br>3.31.5".
  assert.deepEqual(m.tools.CMake, ['3.31.6']);
});

test('reads bare-version bullet lists under a Cached Tools subheading', async () => {
  const m = parseManifest(await readFixture('ubuntu-22.04'));
  assert.deepEqual(m.tools.Go, ['1.24.13', '1.25.12', '1.26.5']);
});

test('reads the Java table, which has no name column', async () => {
  const m = parseManifest(await readFixture('ubuntu-22.04'));
  assert.deepEqual(m.tools.Java, ['8.0.492+9', '11.0.31+11', '17.0.19+10', '21.0.11+10', '25.0.3+9']);
});

test('parses a macOS manifest, which names things differently', async () => {
  const m = parseManifest(await readFixture('macos-15'), 'macos-15');
  assert.equal(m.osVersion, 'macOS 15.7.7 (24G720)');
  assert.equal(m.imageVersion, '20260720.0353.1');
  assert.deepEqual(m.tools.Python3, ['3.14.6']);
  assert.deepEqual(m.tools['Node.js'], ['22.23.1']);
});

test('lookupTool falls back through candidate names, case-insensitively', async () => {
  const m = parseManifest(await readFixture('macos-15'), 'macos-15');
  assert.equal(lookupTool(m, ['Python', 'Python3'])?.name, 'Python');
  // macOS really does spell it "Cmake 4.4.0" while Ubuntu says "CMake 3.31.6".
  assert.deepEqual(lookupTool(m, ['CMake']), { name: 'Cmake', versions: ['4.4.0'] });
  assert.equal(lookupTool(m, ['Nope']), null);
  assert.equal(lookupTool(null, ['Python']), null);
});

test('never crashes on empty or junk input', () => {
  const empty = parseManifest('');
  assert.equal(empty.imageVersion, null);
  assert.deepEqual(empty.tools, {});
  const junk = parseManifest('| broken |\n|-|\nnot a manifest at all\n- \n');
  assert.equal(junk.imageVersion, null);
});

test('manifestUrl maps labels to verified runner-images paths', () => {
  assert.equal(
    manifestUrl('ubuntu-22.04'),
    'https://raw.githubusercontent.com/actions/runner-images/main/images/ubuntu/Ubuntu2204-Readme.md',
  );
  assert.equal(manifestUrl('made-up-label'), null);
});

test('loadFixtureManifest reports an unknown label as skipped, not a crash', async () => {
  const m = await loadFixtureManifest('ubuntu-99.04');
  assert.equal(m.skipped, true);
  assert.match(m.reason, /no fixture/);
});

/**
 * The manifest parser is linear, and this is what says so.
 *
 * Six `js/polynomial-redos` alerts sat open on this file from 2026-08-14. The
 * worst were the trailing-parenthesis note stripper and the version cleaner:
 * `\s*\(...\)\s*$` and `\s*\(default\)\s*` both re-try their leading whitespace
 * run from every start position when the rest of the pattern cannot match, so an
 * unclosed parenthesis after a long stretch of spaces went quadratic. 240k
 * characters took 45 seconds; the same input now takes about a millisecond.
 *
 * The budget is loose enough that a slow CI box cannot fail it, and tight enough
 * that any reintroduction blows straight through it.
 */
test('parseManifest stays linear on pathological input', () => {
  const CR = String.fromCharCode(13);
  const pad = ' '.repeat(240_000);
  const BUDGET_MS = 2000;

  const cases = [
    ['a parenthesis that is never closed', `- Tool 1.0 (${pad}x`],
    ['spaces then an unclosed (default', `- Tool 1.0${pad}(default`],
    ['a bullet body with no version', `- ${'a'.repeat(240_000)}:${pad}`],
    ['an OS Version line with a stray CR', `- OS Version:${pad}${CR}`],
    ['an Image Version line with a stray CR', `- Image Version:${pad}${CR}`],
    ['a table cell full of open parens', `| Name | V |\n|---|---|\n| a${'('.repeat(60_000)} | 1.0 |`],
  ];

  for (const [label, input] of cases) {
    const started = performance.now();
    parseManifest(input, 'ubuntu-22.04');
    const elapsed = performance.now() - started;
    assert.ok(elapsed < BUDGET_MS, `${label} took ${elapsed.toFixed(0)}ms, budget ${BUDGET_MS}ms`);
  }
});
