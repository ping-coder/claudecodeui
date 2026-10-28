import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultFilter } from 'cmdk';

import { createFileSearchScorer } from '@/modules/file-tree/file-search-score.service.js';

/**
 * The project file search returns the best matches the command palette would
 * pick, so its scorer has to agree with the palette's to the last digit: the
 * palette re-scores what the server sends and hides a row that scores 0. These
 * tests hold the port against cmdk itself, through the palette's `scoreFile`.
 */

const ROOT = '/home/u/claudecodeui';

// The palette's scoreFile (CommandPalette.tsx), for a file of the project at ROOT.
function scoreLikeThePalette(relativePath: string, search: string): number {
  const query = search.replace(/\\/g, '/');
  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  const absolutePath = `${ROOT}/${relativePath}`.replace(/\\/g, '/');
  const root = absolutePath.endsWith(normalizedRelativePath)
    ? absolutePath.slice(0, -normalizedRelativePath.length)
    : '';
  return defaultFilter(normalizedRelativePath, root && query.startsWith(root) ? query.slice(root.length) : query);
}

function assertScoresAgree(relativePaths: string[], queries: string[]): void {
  for (const query of queries) {
    const scoreRelativePath = createFileSearchScorer(ROOT, query);
    for (const relativePath of relativePaths) {
      assert.equal(
        scoreRelativePath(relativePath),
        scoreLikeThePalette(relativePath, query),
        `${JSON.stringify(query)} on ${relativePath}`,
      );
    }
  }
}

test('the search scores everyday paths and searches exactly as the palette does', () => {
  const relativePaths = [
    'README.md',
    'CLAUDE.md',
    '.env',
    'package.json',
    'src/modules/command-palette/CommandPalette.tsx',
    'src/modules/command-palette/hooks/useFilesSource.ts',
    'src/shared/api.ts',
    'server/modules/file-tree/file-tree.service.ts',
    'docs/claude-notes-2.md',
    '.github/workflows/ci.yml',
    'snake_case_name.py',
    'kebab-case-name.ts',
    'with space/file name.txt',
    'Makefile',
    'tests/aa.test.ts',
    'notes(1)/draft&final.md',
    'café/naïve résumé.md',
    '中文/文件名.md',
    // Shorter than some searches: a doubled letter typed where the name has one still matches.
    'ab',
    'x',
  ];
  const queries = [
    'readme', 'README', 'ReadMe', 'claude', 'pal', 'cmdpal', 'palette', 'usefiles', 'src/shared', 'api',
    'ts', 'tree service', 'tree-service', 'snake', 'kebab case', 'file name', 'makefile', 'aa', 'ba', 'ab',
    'rdme', 'eadme', 'x', 'xx', 'abb', '.env', 'ci.yml', 'draft&', '(1)', 'résumé', '中文', '文件', 'zzz', '',
    // Pasted paths: absolute ones are read relative to the root, backslashes as slashes.
    `${ROOT}/src/shared/api.ts`,
    `${ROOT}\\src\\shared\\api.ts`.replace(/\//g, '\\'),
    `${ROOT}/`,
    'src\\shared\\api.ts',
    '/home/u/other-project/README.md',
  ];

  assertScoresAgree(relativePaths, queries);
});

test('a search with a dotted capital I scores as the palette does', () => {
  // 'İ' (U+0130) lower-cases to two code units, 'i' and U+0307, and the palette compares only as
  // many as the search has, so 'dosyaİ' finds dosyai.txt. Mixed into the random sample below,
  // some of its combinations overflow cmdk's stack, so it gets cases of its own. In 'İiİ' a
  // transposition over the doubled 'i' in the middle of its lower case leads past the three
  // characters typed, to the U+0307 of the last 'İ': still inside the lower-cased search, where
  // the palette goes on matching.
  const relativePaths = [
    'src/main.ts', 'src/cli.ts', 'dosyai.txt', 'i', 'kitap/İçindekiler.md', 'İstanbul/notlar.md', 'README.md',
    'İi', 'kitap/İi.md', 'İia',
  ];
  const queries = ['İ', 'dosyaİ', 'srcİ', 'CLİ', 'İs', 'İndex', 'İİ', 'İiİ'];

  assertScoresAgree(relativePaths, queries);
});

test('a path that overflows cmdk\'s stack scores 0, so the palette is never sent one', () => {
  // These take cmdk past the end of the lower-cased search, where it matches the empty string
  // until its stack overflows; the palette scores the files the server sends with cmdk. The last
  // reaches a part of the search that only its lower case has, which the memo must keep apart.
  const cases = [['İ̇', 'i̇'], ['İ̇', 'aİ'], ['iİİ̇İ', 'İİii'], ['İİiİİ', '̇iİİ̇']] as const;
  for (const [query, relativePath] of cases) {
    assert.throws(() => scoreLikeThePalette(relativePath, query), RangeError);
    assert.equal(createFileSearchScorer(ROOT, query)(relativePath), 0, `${JSON.stringify(query)} on ${relativePath}`);
  }
});

test('a long path pasted whole scores as the palette does', () => {
  const directories = [
    'packages', 'server-runtime', 'src', 'modules', 'providers', 'claude', 'sessions', 'transcripts',
    'fixtures', 'generated', 'snapshots', 'components', 'command-palette', 'hooks', 'useFileSearch',
  ];
  const relativePath = `${Array.from({ length: 24 }, (_, index) => directories[(index * 7) % directories.length]).join('/')}/file-search-score.service.test.ts`;
  assert.equal(relativePath.length > 250, true);

  assertScoresAgree([relativePath, relativePath.replace('score', 'tree')], [relativePath, relativePath.slice(-60)]);
});

test('a path that takes too long to score scores 0, though the palette would match it', () => {
  // A letter repeated throughout the path and the search: scoring it takes time that grows with
  // the path's length squared times the search's, here well over the server's step limit. With a
  // slash or a space after every letter, the scorer also counts the word breaks it skips, again
  // and again. With another letter between every two, as in this 249-character file name, nearly
  // every round also works out a jump and tries a transposition, which count two steps more each:
  // either alone would leave the shorter search under the limit.
  const alternating = `${'xa'.repeat(120)}-0001.txt`;
  const cases = [
    ['e'.repeat(200), 'e'.repeat(30)],
    ['e/'.repeat(66), 'e'.repeat(10)],
    ['e '.repeat(66), 'e'.repeat(10)],
    [alternating, 'a'.repeat(30)],
    [alternating, 'a'.repeat(10)],
  ] as const;
  for (const [relativePath, query] of cases) {
    assert.equal(createFileSearchScorer(ROOT, query)(relativePath), 0, `${query} on ${relativePath}`);
    assert.equal(scoreLikeThePalette(relativePath, query) > 0, true);
  }
  // Shorter, the same kind of path and search stays well under the limit.
  assertScoresAgree(['e'.repeat(132), 'e/'.repeat(20)], ['e'.repeat(10)]);
});

test('the search scores a large varied sample exactly as the palette does', () => {
  // A seeded generator, so a failure names a path and search that reproduce.
  let seed = 20261029;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
  const words = [
    'src', 'Server', 'modules', 'file', 'tree', 'Command', 'palette', 'index', 'README', 'claude',
    'notes', 'test', 'api', 'shared', 'utils', 'Ä', 'é', 'x', 'aa', 'q',
  ];
  const separators = ['/', '_', '-', '.', ' ', '', '@', '#', '+', '(', '&'];
  const word = () => (random() < 0.2 ? pick(words).toUpperCase() : pick(words));
  const relativePaths = Array.from({ length: 1_500 }, () => (
    Array.from({ length: 1 + Math.floor(random() * 4) }, () => (
      Array.from({ length: 1 + Math.floor(random() * 3) }, word).join(pick(separators))
    )).join('/')
  ));
  // Searches cut from the paths themselves (typed in another case, a letter
  // dropped or two swapped) and some made of loose words.
  const queries = Array.from({ length: 40 }, () => {
    const source = pick(relativePaths);
    const start = Math.floor(random() * source.length);
    let query = source.slice(start, start + 1 + Math.floor(random() * 8));
    const variant = random();
    if (variant < 0.25) {
      query = query.toUpperCase();
    } else if (variant < 0.5 && query.length > 2) {
      const index = Math.floor(random() * (query.length - 1));
      query = query.slice(0, index) + query.charAt(index + 1) + query.charAt(index) + query.slice(index + 2);
    } else if (variant < 0.75 && query.length > 2) {
      const index = Math.floor(random() * query.length);
      query = query.slice(0, index) + query.slice(index + 1);
    } else if (variant < 0.85) {
      query = `${pick(words)} ${pick(words)}`;
    }
    return query;
  });

  assertScoresAgree(relativePaths, queries);
});
