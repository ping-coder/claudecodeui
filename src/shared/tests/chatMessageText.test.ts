import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { convertMarkdownToPlainText, isTurnOpener } from '@/shared/utils';

/**
 * The text helpers chat's copy control and pinned question share: markdown to
 * readable plain text, and which rows open a turn.
 */

describe('convertMarkdownToPlainText', () => {
  it('keeps the code of a fenced block and drops its fence', () => {
    assert.equal(convertMarkdownToPlainText('Run this:\n\n```bash\nnpm test\n```'), 'Run this:\n\nnpm test');
  });

  it('drops inline marks, keeping their text', () => {
    assert.equal(
      convertMarkdownToPlainText('**Fix** the _scroll_ `bug` in ~~old~~ [the pane](src/pane.tsx) ![shot](a.png)'),
      'Fix the scroll bug in old the pane shot',
    );
  });

  it('drops headings, quotes, list markers and HTML tags', () => {
    assert.equal(
      convertMarkdownToPlainText('# Title\n> quoted\n- one\n2. two\n<b>bold</b>'),
      'Title\nquoted\none\ntwo\nbold',
    );
  });

  it('folds Windows line ends and runs of blank lines', () => {
    assert.equal(convertMarkdownToPlainText('first\r\n\r\n\r\n\r\nsecond\r\n'), 'first\n\nsecond');
  });
});

describe('isTurnOpener', () => {
  it('is true for a user message and false for one inserted into a running turn', () => {
    assert.equal(isTurnOpener({ type: 'user', content: 'Why?', timestamp: '2026-10-28T12:00:00.000Z' }), true);
    assert.equal(isTurnOpener({ type: 'user', content: 'Also this', timestamp: '2026-10-28T12:00:01.000Z', inserted: true }), false);
  });

  it('is false for the assistant\'s rows, a background task\'s report among them', () => {
    assert.equal(isTurnOpener({ type: 'assistant', content: 'Because…', timestamp: '2026-10-28T12:00:02.000Z' }), false);
    assert.equal(isTurnOpener({ type: 'assistant', content: 'Task done', timestamp: '2026-10-28T12:00:03.000Z', isTaskNotification: true }), false);
  });
});
