import assert from 'node:assert/strict';

import { test } from 'vitest';

/**
 * Simplified Chinese writes an ellipsis as "…" (i18n.md, 术语和口吻), as the fork's own strings
 * do: never three full stops, which upstream's older strings used ("加载中...").
 */

type Tree = { [key: string]: string | Tree };

const files = import.meta.glob<Tree>('/src/modules/i18n/locales/zh-CN/*.json', { eager: true, import: 'default' });

function* strings(tree: Tree, prefix = ''): Generator<[string, string]> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') yield [path, value];
    else yield* strings(value, path);
  }
}

test('zh-CN writes no ellipsis of three full stops', () => {
  const offenders: string[] = [];
  for (const [path, tree] of Object.entries(files)) {
    const ns = path.split('/').pop()?.replace(/\.json$/, '') ?? path;
    for (const [key, value] of strings(tree)) {
      if (value.includes('...')) offenders.push(`${ns}:${key}`);
    }
  }
  assert.equal(Object.keys(files).length > 0, true);
  assert.deepEqual(offenders, []);
});
