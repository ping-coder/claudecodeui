import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

/**
 * The global `select` rule in src/index.css draws the dropdown arrow at the end of the field and
 * keeps `padding-inline-end: 2.5rem` clear for it. A padding utility on the element outranks that
 * rule, so a select that sets its own padding leaves the end side alone or sets it back with
 * `pe-10`: a logical side, which moves to the left with the arrow in a right-to-left layout. A long
 * option label then stops short of the arrow instead of running under it.
 */

// Resolved from this file's path rather than with `new URL(…, import.meta.url)`: under
// jsdom, URL is jsdom's class, which node:url does not accept.
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The class list of each `<select>` that sets it as a string, with the file it is in. */
function readSelectClassLists(): Array<{ file: string; classes: string[] }> {
  const found: Array<{ file: string; classes: string[] }> = [];
  const files = readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.tsx'));
  for (const file of files) {
    const source = readFileSync(join(SOURCE_ROOT, file), 'utf8');
    // Up to the select's own className: no other tag opens before it.
    for (const match of source.matchAll(/<select\b[^<]*?className="([^"]*)"/g)) {
      found.push({ file, classes: match[1].split(/\s+/) });
    }
  }
  return found;
}

/** Padding that takes the arrow's room: all sides, both inline sides, a physical side, or a narrower end. */
const NARROWS_ARROW_ROOM = /^(p|px|pl|pr)-|^pe-(?!10$)/;

test('no select narrows the room at its end that the arrow is drawn in', () => {
  const selects = readSelectClassLists();
  const narrowed = selects
    .filter(({ classes }) => classes.some((name) => NARROWS_ARROW_ROOM.test(name.slice(name.lastIndexOf(':') + 1))))
    .map(({ file, classes }) => `${file}: ${classes.join(' ')}`);

  assert.equal(selects.length > 0, true, 'no select was read');
  assert.equal(narrowed.join('\n'), '');
});
