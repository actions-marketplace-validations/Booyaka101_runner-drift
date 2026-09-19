/**
 * Fetch + parse a runner-images `*-Readme.md` installed-software manifest.
 *
 * Real-world shapes handled (all observed in the live manifests):
 *   - CMake 3.31.6                        -> CMake: ['3.31.6']
 *   - Clang: 13.0.1, 14.0.0, 15.0.7       -> Clang: ['13.0.1','14.0.0','15.0.7']
 *   - AzCopy 10.32.4 - available by `az`  -> AzCopy: ['10.32.4']
 *   - Bash 5.1.16(1)-release              -> Bash: ['5.1.16(1)-release']
 *   - GCC 13 (Homebrew GCC 13.4.0)        -> GCC: ['13']
 *   #### Go / - 1.24.13 / - 1.25.12       -> Go: ['1.24.13','1.25.12']   (Cached Tools)
 *   | CMake | 3.22.1<br>3.31.5 |          -> table rows
 *   | Version | Environment Variable |    -> Java table, keyed on the section name
 *
 * FIRST OCCURRENCE WINS. Manifests list the real host tool as a top-level
 * bullet before the Android SDK tables repeat some of those names for bundled
 * SDK components, so document order is what disambiguates e.g. CMake 3.31.6
 * (the host tool) from CMake 3.18.1/3.22.1/3.31.5 (the Android SDK packages).
 * Android SDK tables are skipped outright for the same reason.
 */

import { fetchText, NotFoundError, DriftError } from './http.mjs';
import { RAW_BASE, pathForLabel } from './labels.mjs';

const HEADER_KEYS = new Set([
  'os version',
  'image version',
  'kernel version',
  'systemd version',
  'image release',
]);

/** Sections whose tables list SDK sub-packages rather than host tools. */
const SKIP_TABLE_SECTIONS = new Set(['android']);

function stripTrailingNote(s) {
  // "AzCopy 10.32.4 - available by `azcopy`" -> "AzCopy 10.32.4"
  const i = s.indexOf(' - ');
  return (i === -1 ? s : s.slice(0, i)).trim();
}

/**
 * The notes are stripped first and the gap they leave collapsed after, rather
 * than matching `\s*\(default\)\s*`. With a global replace that leading run is
 * ambiguous at every start position, so a long stretch of spaces is quadratic.
 */
function cleanVersion(v) {
  return v
    .replace(/\(default\)/gi, '')
    .replace(/\(rev\s+\d+\)/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[`*]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function looksLikeVersion(v) {
  return /^v?\d/.test(v);
}

function splitVersionList(s) {
  return s
    .split(/[,•]|<br\s*\/?>/i)
    .map((x) => cleanVersion(x))
    .flatMap((x) => (x.includes(' ') && /^\d[\w.+~-]*( \d[\w.+~-]*)+$/.test(x) ? x.split(/\s+/) : [x]))
    .filter((x) => x && looksLikeVersion(x))
    .map((x) => x.replace(/^v/, ''));
}

/**
 * Drop a trailing `(...)` note whose contents contain whitespace, which is what
 * separates "GCC 13 (Homebrew GCC 13.4.0)" from "5.1.16(1)-release".
 */
function stripTrailingParenNote(s) {
  const body = s.trimEnd();
  if (!body.endsWith(')')) return body;
  const open = body.lastIndexOf('(');
  if (open === -1) return body;
  const inner = body.slice(open + 1, -1);
  if (inner.includes('(') || inner.includes(')') || !/\s/.test(inner)) return body;
  return body.slice(0, open).trim();
}

function parseBullet(rawLine) {
  let body = stripTrailingNote(rawLine.replace(/^\s*-\s+/, '').trim()).replace(/[`]/g, '');
  if (!body) return null;

  // "GCC 13 (Homebrew GCC 13.4.0)" -> "GCC 13"; leaves "5.1.16(1)-release" alone.
  //
  // Deliberately not a regex. Every regex spelling of "optional whitespace, then
  // a parenthesised group, at the end" re-tries that leading run from every
  // position when the parenthesis is never closed, which is quadratic. Indexing
  // from the last `(` is the same rule in linear time.
  body = stripTrailingParenNote(body);

  const colon = body.match(/^([^:]+):[ \t]*([^\r\n]+)/);
  if (colon) {
    const name = colon[1].trim();
    if (HEADER_KEYS.has(name.toLowerCase())) return null;
    const versions = splitVersionList(colon[2]);
    return versions.length ? { name, versions } : null;
  }

  const trailing = body.match(/^(.*?[^\s.])\s+(v?\d[\w.+~()-]*)$/);
  if (trailing) {
    const name = trailing[1].trim();
    if (!name || HEADER_KEYS.has(name.toLowerCase())) return null;
    const versions = splitVersionList(trailing[2]);
    return versions.length ? { name, versions } : null;
  }

  // Bare version bullet, e.g. the "#### Go" list under "### Cached Tools".
  const bare = body.match(/^(v?\d[\w.+~-]*)(\s+\[.*\])?$/);
  if (bare) {
    const versions = splitVersionList(bare[1]);
    return versions.length ? { name: null, versions } : null;
  }
  return null;
}

function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  return cells.length >= 2 ? cells : null;
}

function isSeparatorRow(cells) {
  return cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * Parse a manifest markdown document.
 * @returns {{label:string|null, title:string|null, osVersion:string|null,
 *            imageVersion:string|null, tools:Record<string,string[]>,
 *            toolSections:Record<string,string>}}
 */
export function parseManifest(markdown, label = null) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const tools = Object.create(null);
  const toolSections = Object.create(null);
  let osVersion = null;
  let imageVersion = null;
  let title = null;
  let section = '';
  let subsection = '';
  let inFence = false;

  const add = (name, versions, where) => {
    const key = String(name).trim();
    if (!key || !versions?.length) return;
    if (HEADER_KEYS.has(key.toLowerCase())) return;
    if (key in tools) return; // first occurrence wins
    tools[key] = versions;
    toolSections[key] = where;
  };

  // Table state
  let tableHeader = null;
  let versionCol = -1;
  let nameCol = -1;

  const resetTable = () => {
    tableHeader = null;
    versionCol = -1;
    nameCol = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^#\s+/.test(line)) {
      if (!title) title = line.replace(/^#\s+/, '').trim();
      section = '';
      subsection = '';
      resetTable();
      continue;
    }
    if (/^###\s+/.test(line)) {
      section = line.replace(/^#+\s+/, '').trim();
      subsection = '';
      resetTable();
      continue;
    }
    if (/^####\s+/.test(line)) {
      subsection = line.replace(/^#+\s+/, '').trim();
      resetTable();
      continue;
    }
    if (/^##\s+/.test(line)) {
      section = line.replace(/^#+\s+/, '').trim();
      subsection = '';
      resetTable();
      continue;
    }

    const osM = line.match(/^[ \t]*-[ \t]+OS Version:[ \t]*([^\r\n]+)/i);
    if (osM) {
      osVersion ??= osM[1].trim();
      continue;
    }
    const ivM = line.match(/^[ \t]*-[ \t]+Image Version:[ \t]*([^\r\n]+)/i);
    if (ivM) {
      imageVersion ??= ivM[1].trim();
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      resetTable();
      const parsed = parseBullet(line);
      if (parsed) {
        const name = parsed.name ?? subsection;
        if (parsed.name) {
          add(name, parsed.versions, subsection || section);
        } else if (subsection) {
          // Bare-version bullet list under a "#### Tool" heading — accumulate.
          if (!(subsection in tools)) {
            tools[subsection] = [];
            toolSections[subsection] = section;
          }
          if (toolSections[subsection] === section) {
            for (const v of parsed.versions) {
              if (!tools[subsection].includes(v)) tools[subsection].push(v);
            }
          }
        }
      }
      continue;
    }

    const cells = splitRow(line);
    if (!cells) {
      resetTable();
      continue;
    }
    if (isSeparatorRow(cells)) continue;

    if (!tableHeader) {
      tableHeader = cells.map((c) => c.toLowerCase());
      versionCol = tableHeader.findIndex((c) => /version/.test(c));
      nameCol = tableHeader.findIndex((c) => /name|package|tool|component/.test(c));
      continue;
    }

    if (SKIP_TABLE_SECTIONS.has(section.toLowerCase())) continue;
    if (/environment variables?/i.test(subsection)) continue;
    if (versionCol === -1) continue;

    if (nameCol === -1) {
      // e.g. the Java table: | Version | Environment Variable | -> key on section.
      const key = subsection || section;
      if (!key) continue;
      const versions = splitVersionList(cells[versionCol]);
      if (!versions.length) continue;
      if (!(key in tools)) {
        tools[key] = [];
        toolSections[key] = section;
      }
      if (toolSections[key] === section) {
        for (const v of versions) if (!tools[key].includes(v)) tools[key].push(v);
      }
      continue;
    }

    // `[^()]*` rather than a lazy `.*?`, which re-expands to the end of the
    // string from every `(` when one is unclosed. Same match on real cells.
    const name = cells[nameCol]?.replace(/[`*[\]]/g, '').replace(/\([^()]*\)/g, '').trim();
    const versions = splitVersionList(cells[versionCol] ?? '');
    if (name && versions.length) add(name, versions, section);
  }

  // Plain objects out (the accumulators are null-prototype to stay collision-free).
  return { label, title, osVersion, imageVersion, tools: { ...tools }, toolSections: { ...toolSections } };
}

/** Build the raw URL for a label's manifest at a given git ref. */
export function manifestUrl(label, ref = 'main') {
  const path = pathForLabel(label);
  if (!path) return null;
  return `${RAW_BASE}/${ref}/${path}`;
}

/**
 * Fetch and parse a label's manifest.
 * Returns null (never throws) when the label is unknown or the path 404s,
 * with the reason on `.skipped`.
 */
export async function loadManifest(label, { ref = 'main' } = {}) {
  const url = manifestUrl(label, ref);
  if (!url) {
    return {
      skipped: true,
      label,
      reason: `Unknown runner label "${label}" — runner-drift has no runner-images manifest path for it.`,
    };
  }
  let res;
  try {
    res = await fetchText(url, { allow404: true });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { skipped: true, label, reason: `No manifest at ${url} (404).` };
    }
    throw err;
  }
  if (!res.ok) {
    return { skipped: true, label, reason: `No manifest at ${url} (404).` };
  }
  const parsed = parseManifest(res.text, label);
  if (!parsed.imageVersion) {
    throw new DriftError(`Manifest at ${url} has no "Image Version:" line — format changed?`, {
      code: 'MANIFEST_SHAPE',
      hint: 'Please open an issue at https://github.com/Booyaka101/runner-drift/issues',
    });
  }
  return { ...parsed, skipped: false, url, ref };
}

/**
 * Case-insensitive lookup of the first matching candidate name.
 * @returns {{name:string, versions:string[]}|null}
 */
export function lookupTool(manifest, candidates) {
  if (!manifest?.tools) return null;
  const index = new Map(Object.keys(manifest.tools).map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const hit = index.get(String(c).toLowerCase());
    if (hit) return { name: hit, versions: manifest.tools[hit] };
  }
  return null;
}
