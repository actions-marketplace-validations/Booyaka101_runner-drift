import test from 'node:test';
import assert from 'node:assert/strict';
import {
  imageVersionFromMessage,
  compareImageVersions,
  findCommitForImageVersion,
  commitWindow,
  listManifestCommits,
  manifestAtSha,
} from '../src/history.mjs';
import { readFixture, stubApi } from './helpers.mjs';

test('Xcode history is path-based for both aliases, ordered by numeric image version', async () => {
  const recorded = JSON.parse(await readFixture('xcode-27-commits-recorded.json'));
  const body = await readFixture('xcode-27');
  const api = stubApi((url) => ({ status: 200, body: url.startsWith('https://api.github.com/') ? recorded : body }));
  try {
    for (const label of ['xcode-27', 'xcode-27-xlarge']) {
      const commits = await listManifestCommits(label);
      assert.deepEqual(commits.map((c) => c.imageVersion), ['20261022.0305.3', '20261023.0307.1']);
      assert.equal(findCommitForImageVersion(commits, '20261024.1.1').commit.imageVersion, '20261023.0307.1');
      assert.equal(findCommitForImageVersion(commits, '20261022.0305.3').approximate, false);
      assert.deepEqual(commitWindow(commits, '20261021.1.1', '20261023.0307.1').map((c) => c.imageVersion),
        ['20261022.0305.3', '20261023.0307.1']);
      const m = await manifestAtSha(label, commits[0].sha);
      assert.deepEqual(m.tools.Xcode, ['27.2', '27.1', '27.0']);
    }
    for (const url of api.calls) {
      assert.ok(url.includes('images%2Fmacos%2Fxcode-27-arm64-Readme.md') || url.endsWith('/images/macos/xcode-27-arm64-Readme.md'));
    }
  } finally {
    api.restore();
  }
});

/**
 * Real commit metadata, captured from
 * api.github.com/repos/actions/runner-images/commits?path=images/ubuntu/Ubuntu2204-Readme.md
 */
const COMMITS = [
  {
    sha: '3b7fa9c1aa1efb5fc0ba4b443dcfa69f47f53434',
    date: '2026-07-27T08:20:56Z',
    message: 'Updating readme file for ubuntu22 version 20260720.234.2 (#14428)',
    url: 'https://github.com/actions/runner-images/commit/3b7fa9c1aa1efb5fc0ba4b443dcfa69f47f53434',
  },
  {
    sha: 'f3d0fbf668c2d437a5a5a03e75206801e22e5e62',
    date: '2026-07-17T12:47:12Z',
    message: 'Updating readme file for ubuntu22 version 20260714.228.1 (#14387)',
    url: 'https://github.com/actions/runner-images/commit/f3d0fbf668c2d437a5a5a03e75206801e22e5e62',
  },
  {
    sha: 'e161e34abf7daee57ad0ba305cc893a863892c2b',
    date: '2026-07-10T11:59:55Z',
    message: 'Updating readme file for ubuntu22 version 20260705.219.1 (#14335)',
    url: 'https://github.com/actions/runner-images/commit/e161e34abf7daee57ad0ba305cc893a863892c2b',
  },
  {
    sha: 'c951a11bcecc3971da5b0abba2337340b0fa9c8e',
    date: '2026-07-03T15:11:24Z',
    message: 'Updating readme file for ubuntu22 version 20260629.205.1 (#14315)',
    url: 'https://github.com/actions/runner-images/commit/c951a11bcecc3971da5b0abba2337340b0fa9c8e',
  },
  {
    sha: '9a67eba486d1149ca983b66eb2e9b718744059e6',
    date: '2026-06-26T14:54:32Z',
    message: 'Updating readme file for ubuntu22 version 20260623.199.1 (#14286)',
    url: 'https://github.com/actions/runner-images/commit/9a67eba486d1149ca983b66eb2e9b718744059e6',
  },
].map((c) => ({ ...c, imageVersion: imageVersionFromMessage(c.message) }));

test('parses the image version out of a rollout commit message', () => {
  assert.equal(
    imageVersionFromMessage('Updating readme file for ubuntu22 version 20260720.234.2 (#14428)'),
    '20260720.234.2',
  );
  assert.equal(imageVersionFromMessage('Merge pull request #1 from foo/bar'), null);
  assert.equal(imageVersionFromMessage(undefined), null);
});

test('image versions compare numerically, not lexically', () => {
  assert.equal(compareImageVersions('20260720.234.2', '20260714.228.1'), 1);
  assert.equal(compareImageVersions('20260720.99.1', '20260720.234.1'), -1); // 99 < 234
  assert.equal(compareImageVersions('20260720.234.2', '20260720.234.2'), 0);
});

test('an exact image version resolves to its own commit', () => {
  const hit = findCommitForImageVersion(COMMITS, '20260705.219.1');
  assert.equal(hit.approximate, false);
  assert.equal(hit.commit.sha, 'e161e34abf7daee57ad0ba305cc893a863892c2b');
});

test('an image version missing from history falls back to the nearest EARLIER commit', () => {
  // The readme lags the rollout: the runner reports 20260718.x before the
  // readme commit for it exists.
  const hit = findCommitForImageVersion(COMMITS, '20260718.231.1');
  assert.equal(hit.approximate, true);
  assert.equal(hit.commit.imageVersion, '20260714.228.1');
  assert.match(hit.reason, /nearest earlier 20260714\.228\.1/);
});

test('an image version older than all history returns null rather than guessing forward', () => {
  assert.equal(findCommitForImageVersion(COMMITS, '20250101.1.1'), null);
  assert.equal(findCommitForImageVersion(COMMITS, null), null);
});

test('commitWindow returns the rollouts between two locked versions, oldest first', () => {
  const w = commitWindow(COMMITS, '20260629.205.1', '20260720.234.2');
  assert.deepEqual(
    w.map((c) => c.imageVersion),
    ['20260705.219.1', '20260714.228.1', '20260720.234.2'],
  );
});

test('commitWindow is empty when nothing shipped in between', () => {
  assert.deepEqual(commitWindow(COMMITS, '20260720.234.2', '20260720.234.2'), []);
});
