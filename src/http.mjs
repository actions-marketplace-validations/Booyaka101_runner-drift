/**
 * The only network layer in runner-drift.
 *
 * Hard constraint (enforced here, not just documented): the tool talks to
 * raw.githubusercontent.com and api.github.com and nothing else.
 */

const ALLOWED_HOSTS = new Set(['raw.githubusercontent.com', 'api.github.com']);

export class DriftError extends Error {
  constructor(message, { code = 'ERROR', hint = null } = {}) {
    super(message);
    this.name = 'DriftError';
    this.code = code;
    this.hint = hint;
  }
}

/** One line for a caught failure: a DriftError's hint belongs with its message. */
export function errorText(err) {
  if (!(err instanceof DriftError)) return String(err);
  return err.hint ? `${err.message} ${err.hint}` : err.message;
}

export class NotFoundError extends DriftError {
  constructor(message) {
    super(message, { code: 'NOT_FOUND' });
    this.name = 'NotFoundError';
  }
}

function assertAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new DriftError(`Not a valid URL: ${url}`, { code: 'BAD_URL' });
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    throw new DriftError(
      `Refusing to contact ${u.hostname}: runner-drift only talks to ${[...ALLOWED_HOSTS].join(' and ')}.`,
      { code: 'HOST_NOT_ALLOWED' },
    );
  }
  return u;
}

function authHeaders() {
  const token =
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
  const headers = {
    'user-agent': 'runner-drift/1.4.1 (+https://github.com/Booyaka101/runner-drift)',
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

const RATE_LIMIT_HINT =
  'GitHub rate limit reached for this IP. Set GITHUB_TOKEN (inside a workflow: ' +
  'env: GITHUB_TOKEN: ${{ github.token }}) — runner-drift uses it only to raise the rate limit.';

/**
 * Fetch a URL, returning text. Throws DriftError with an actionable message on
 * rate limit / network failure, NotFoundError on 404.
 */
export async function fetchText(url, { timeoutMs = 20000, allow404 = false } = {}) {
  assertAllowed(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers: authHeaders(), signal: ac.signal, redirect: 'follow' });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new DriftError(`Timed out after ${timeoutMs}ms fetching ${url}`, {
        code: 'TIMEOUT',
        hint: 'Check network access to raw.githubusercontent.com / api.github.com.',
      });
    }
    throw new DriftError(`Network error fetching ${url}: ${err?.message || err}`, {
      code: 'NETWORK',
      hint: 'runner-drift needs outbound HTTPS to raw.githubusercontent.com and api.github.com.',
    });
  } finally {
    clearTimeout(timer);
  }

  // A Response whose body is never read keeps its socket open, so a CLI that
  // reports a failure and returns never exits — it just sits there holding the
  // failure it already detected. Every branch below either returns or throws, so
  // the failing body is drained here. The runtime lane makes a 404 routine
  // (action.yml, then action.yaml), which is what turns this into a hot path.
  if (!res.ok) await res.text().catch(() => {});

  if (res.status === 404) {
    const e = new NotFoundError(`Not found (404): ${url}`);
    if (allow404) return { ok: false, status: 404, text: null, error: e };
    throw e;
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0' || res.status === 429) {
      const reset = res.headers.get('x-ratelimit-reset');
      const when = reset ? new Date(Number(reset) * 1000).toISOString() : 'shortly';
      throw new DriftError(`GitHub API rate limit exceeded (resets ${when}).`, {
        code: 'RATE_LIMIT',
        hint: RATE_LIMIT_HINT,
      });
    }
    throw new DriftError(`GitHub refused the request (HTTP 403): ${url}`, {
      code: 'FORBIDDEN',
      hint: RATE_LIMIT_HINT,
    });
  }
  if (res.status === 401) {
    throw new DriftError(`GitHub rejected the credentials (HTTP 401): ${url}`, {
      code: 'UNAUTHORIZED',
      hint:
        'This endpoint needs a token. Set GITHUB_TOKEN (inside a workflow: ' +
        'env: GITHUB_TOKEN: ${{ github.token }}), or unset an expired one.',
    });
  }
  if (!res.ok) {
    throw new DriftError(`Unexpected HTTP ${res.status} fetching ${url}`, { code: 'HTTP' });
  }

  const text = await res.text();
  return { ok: true, status: res.status, text, error: null };
}

export async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, opts);
  if (!r.ok) return r;
  try {
    return { ...r, json: JSON.parse(r.text) };
  } catch {
    throw new DriftError(`GitHub returned non-JSON from ${url}`, { code: 'BAD_JSON' });
  }
}
