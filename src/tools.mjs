import { lookup } from './tables.mjs';

/**
 * The alias table: shell command -> canonical tool name, and canonical tool
 * name -> the names that tool goes by in runner-images manifests.
 *
 * Manifest names really do differ per OS (Ubuntu says "Node.js", Windows says
 * "Node"; Ubuntu says "Python", macOS says "Python3"; Ubuntu lists JDKs in a
 * "Java" table while the announcement calls them Temurin), so a canonical tool
 * carries a candidate list and the first name present in the manifest wins.
 */

/** shell command (lowercased, basename) -> canonical tool */
export const COMMAND_ALIASES = {
  python: 'Python',
  python3: 'Python',
  pip: 'Python',
  pip3: 'Python',
  node: 'Node.js',
  npm: 'Node.js',
  npx: 'Node.js',
  cmake: 'CMake',
  ctest: 'CMake',
  clang: 'Clang',
  'clang++': 'Clang',
  gcc: 'GNU C++',
  'g++': 'GNU C++',
  docker: 'Docker Client',
  go: 'Go',
  gofmt: 'Go',
  dotnet: '.NET Core SDK',
  java: 'Temurin',
  javac: 'Temurin',
  mvn: 'Temurin',
  gradle: 'Temurin',
  git: 'Git',
};

/** `uses: actions/setup-*` -> canonical tool */
export const SETUP_ACTION_ALIASES = {
  'actions/setup-python': 'Python',
  'actions/setup-node': 'Node.js',
  'actions/setup-go': 'Go',
  'actions/setup-java': 'Temurin',
  'actions/setup-dotnet': '.NET Core SDK',
};

/** canonical tool -> manifest names to look for, in priority order */
export const MANIFEST_CANDIDATES = {
  Python: ['Python', 'Python3'],
  'Node.js': ['Node.js', 'Node'],
  CMake: ['CMake'],
  Clang: ['Clang', 'Clang/LLVM', 'LLVM'],
  'GNU C++': ['GNU C++', 'GCC', 'GNU C++ (GCC)'],
  'Docker Client': ['Docker Client', 'Docker'],
  Go: ['Go'],
  '.NET Core SDK': ['.NET Core SDK', '.NET SDK'],
  Temurin: ['Temurin', 'Java'],
  Git: ['Git'],
};

export function canonicalTool(name) {
  if (!name) return null;
  const key = String(name).trim();
  if (lookup(MANIFEST_CANDIDATES, key)) return key;
  const alias = lookup(COMMAND_ALIASES, key.toLowerCase());
  if (alias) return alias;
  // Case-insensitive match against canonical names.
  const hit = Object.keys(MANIFEST_CANDIDATES).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ?? key;
}

export function manifestCandidates(tool) {
  return lookup(MANIFEST_CANDIDATES, tool) ?? [tool];
}

export function knownTools() {
  return Object.keys(MANIFEST_CANDIDATES);
}
