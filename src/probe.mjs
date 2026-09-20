/**
 * Probe the *real* installed version of a tool on the machine we're running on.
 *
 * A manifest says what the image was built with; a probe says what the job will
 * actually execute. When they disagree the probe wins, and tools with no probe
 * recipe fall back to manifest-only (recorded as such in the lock, so a source
 * change is never mistaken for a version change).
 */

import { spawnSync } from 'node:child_process';

import { lookup } from './tables.mjs';

const IS_WINDOWS = process.platform === 'win32';

/** canonical tool -> probe recipe(s), tried in order */
export const PROBES = {
  Python: [
    { cmd: 'python3', args: ['--version'], re: /Python\s+([\d][\w.]*)/i },
    { cmd: 'python', args: ['--version'], re: /Python\s+([\d][\w.]*)/i },
  ],
  'Node.js': [{ cmd: 'node', args: ['--version'], re: /v?([\d][\w.-]*)/ }],
  CMake: [{ cmd: 'cmake', args: ['--version'], re: /cmake version ([\d][\w.-]*)/i }],
  Clang: [{ cmd: 'clang', args: ['--version'], re: /clang version (\d+(?:\.\d+)*)/i }],
  'GNU C++': [
    { cmd: 'g++', args: ['-dumpfullversion', '-dumpversion'], re: /^(\d+(?:\.\d+)*)/ },
    { cmd: 'gcc', args: ['-dumpfullversion', '-dumpversion'], re: /^(\d+(?:\.\d+)*)/ },
  ],
  'Docker Client': [{ cmd: 'docker', args: ['--version'], re: /Docker version ([\d][\w.-]*)/i }],
  Go: [{ cmd: 'go', args: ['version'], re: /go(\d+(?:\.\d+)*)/ }],
  '.NET Core SDK': [{ cmd: 'dotnet', args: ['--version'], re: /^([\d][\w.-]*)/m }],
  Temurin: [{ cmd: 'java', args: ['-version'], re: /version "([\d][\w.+_]*)"/ }],
  Git: [{ cmd: 'git', args: ['--version'], re: /git version ([\d][\w.]*)/i }],
};

export function isProbeable(tool) {
  return Boolean(lookup(PROBES, tool));
}

function runOne(recipe, timeoutMs) {
  // On Windows a bare shim name + shell:true is the only reliable spawn
  // (cmd.exe resolves it through PATHEXT; .cmd shims cannot be spawn()ed).
  const res = spawnSync(recipe.cmd, recipe.args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: IS_WINDOWS,
    windowsHide: true,
  });
  if (res.error || res.status === null) return null;
  // `java -version` writes to stderr; several tools split across both.
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  if (!out) return null;
  const m = out.match(recipe.re);
  if (!m) return null;
  return { version: m[1], command: `${recipe.cmd} ${recipe.args.join(' ')}`.trim(), raw: out.split('\n')[0] };
}

/**
 * @returns {{tool, ok:boolean, versions:string[], source:'probe', command, raw}|
 *           {tool, ok:false, reason:string}}
 */
export function probeTool(tool, { timeoutMs = 15000 } = {}) {
  const recipes = lookup(PROBES, tool);
  if (!recipes) return { tool, ok: false, reason: 'no probe recipe' };
  for (const r of recipes) {
    let hit = null;
    try {
      hit = runOne(r, timeoutMs);
    } catch {
      hit = null;
    }
    if (hit) {
      return { tool, ok: true, versions: [hit.version], source: 'probe', command: hit.command, raw: hit.raw };
    }
  }
  return { tool, ok: false, reason: 'not installed or version output unrecognised' };
}

/** Probe many tools. Never throws. */
export function probeTools(tools, opts = {}) {
  const out = Object.create(null);
  for (const t of tools) out[t] = probeTool(t, opts);
  return out;
}
