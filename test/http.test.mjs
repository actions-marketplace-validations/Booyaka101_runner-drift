import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchText, fetchJson, DriftError, NotFoundError } from '../src/http.mjs';

const RAW = 'https://raw.githubusercontent.com/actions/runner-images/main/images/ubuntu/Ubuntu2204-Readme.md';
const API = 'https://api.github.com/repos/actions/runner-images/commits';

function stubFetch(impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = real;
  };
}

function response(status, body = '', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  };
}

test('refuses any host other than the two GitHub endpoints', async () => {
  await assert.rejects(() => fetchText('https://evil.example.com/x'), (err) => {
    assert.ok(err instanceof DriftError);
    assert.equal(err.code, 'HOST_NOT_ALLOWED');
    assert.match(err.message, /raw\.githubusercontent\.com and api\.github\.com/);
    return true;
  });
  await assert.rejects(() => fetchText('not a url'), (err) => err.code === 'BAD_URL');
});

test('a 403 with x-ratelimit-remaining: 0 tells the user to set GITHUB_TOKEN', async () => {
  const restore = stubFetch(async () =>
    response(403, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1786000000' }),
  );
  try {
    await assert.rejects(() => fetchJson(API), (err) => {
      assert.equal(err.code, 'RATE_LIMIT');
      assert.match(err.message, /rate limit exceeded \(resets 2026-/);
      assert.match(err.hint, /Set GITHUB_TOKEN/);
      return true;
    });
  } finally {
    restore();
  }
});

test('a 429 is treated as a rate limit even without the header', async () => {
  const restore = stubFetch(async () => response(429));
  try {
    await assert.rejects(() => fetchJson(API), (err) => err.code === 'RATE_LIMIT');
  } finally {
    restore();
  }
});

test('a plain 403 still points at GITHUB_TOKEN', async () => {
  const restore = stubFetch(async () => response(403, '', { 'x-ratelimit-remaining': '57' }));
  try {
    await assert.rejects(() => fetchText(API), (err) => {
      assert.equal(err.code, 'FORBIDDEN');
      assert.match(err.hint, /GITHUB_TOKEN/);
      return true;
    });
  } finally {
    restore();
  }
});

test('a network failure is an actionable message, not a stack trace', async () => {
  const restore = stubFetch(async () => {
    throw new TypeError('fetch failed');
  });
  try {
    await assert.rejects(() => fetchText(RAW), (err) => {
      assert.equal(err.code, 'NETWORK');
      assert.match(err.message, /Network error fetching/);
      assert.match(err.hint, /outbound HTTPS/);
      return true;
    });
  } finally {
    restore();
  }
});

test('a timeout is reported as a timeout', async () => {
  const restore = stubFetch(async (_url, { signal }) => {
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  });
  try {
    await assert.rejects(() => fetchText(RAW, { timeoutMs: 20 }), (err) => {
      assert.equal(err.code, 'TIMEOUT');
      return true;
    });
  } finally {
    restore();
  }
});

test('404 throws NotFoundError, or returns a soft result with allow404', async () => {
  const restore = stubFetch(async () => response(404));
  try {
    await assert.rejects(() => fetchText(RAW), (err) => err instanceof NotFoundError);
    const soft = await fetchText(RAW, { allow404: true });
    assert.equal(soft.ok, false);
    assert.equal(soft.status, 404);
    assert.ok(soft.error instanceof NotFoundError);
  } finally {
    restore();
  }
});

test('non-JSON from the API is reported clearly', async () => {
  const restore = stubFetch(async () => response(200, '<html>nope</html>'));
  try {
    await assert.rejects(() => fetchJson(API), (err) => err.code === 'BAD_JSON');
  } finally {
    restore();
  }
});

test('an unexpected status is surfaced with its code', async () => {
  const restore = stubFetch(async () => response(502));
  try {
    await assert.rejects(() => fetchText(RAW), (err) => {
      assert.equal(err.code, 'HTTP');
      assert.match(err.message, /HTTP 502/);
      return true;
    });
  } finally {
    restore();
  }
});

/**
 * The user-agent carried `runner-drift/1.0.2` through the whole of 1.1.0,
 * because nothing tied it to the package version. This is that tie.
 */
test('the user-agent version matches package.json', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const src = await readFile(new URL('../src/http.mjs', import.meta.url), 'utf8');
  const ua = src.match(/'user-agent':\s*'runner-drift\/([0-9]+\.[0-9]+\.[0-9]+)/);
  assert.ok(ua, 'the user-agent string is still where this test looks for it');
  assert.equal(ua[1], pkg.version, 'bump the user-agent in src/http.mjs alongside package.json');
});

/** action.yml requests a published version of this package; it has to be this one. */
test('action.yml requests the version being released', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const yml = await readFile(new URL('../action.yml', import.meta.url), 'utf8');
  const dflt = yml.match(/npm version of runner-drift to run\.'\s*\n\s*required: false\s*\n\s*default: '([^']+)'/);
  assert.ok(dflt, "action.yml's version input is still where this test looks for it");
  assert.equal(dflt[1], pkg.version, "bump action.yml's version default alongside package.json");
});
