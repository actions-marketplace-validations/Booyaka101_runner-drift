/**
 * Lookups in the tables this tool keys by a string it did not choose: a runner
 * label out of a workflow file, a tool name off the command line, an `ImageOS`
 * out of the environment.
 */

/**
 * The value at `key`, or null when the table has no such key of its own.
 *
 * A plain index answers `__proto__`, `constructor` and `toString` with
 * something truthy, which has every caller here reporting a label or a tool
 * that does not exist, or crashing on a function where a list was expected.
 */
export function lookup(table, key) {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null;
}
