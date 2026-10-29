import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { convertMarkdownToPlainText } from '@/shared/utils';

/**
 * The plain text the pinned question bar, its inserts and "Copy as text" show drops only real
 * Markdown emphasis, read by CommonMark's flanking rules: a `*` or `_` that cannot open or close
 * (inside a word for `_`, between spaces, with no partner) stays, so identifiers, cron lines and
 * globs read as typed.
 */

const plain = convertMarkdownToPlainText;

describe('marks that are not emphasis', () => {
  it('keeps the underscores of an identifier', () => {
    assert.equal(plain('Use Bash with run_in_background set to true'), 'Use Bash with run_in_background set to true');
    assert.equal(plain('snake_case_name and file_name.ts'), 'snake_case_name and file_name.ts');
    assert.equal(plain('see http://example.com/a_b_c_d'), 'see http://example.com/a_b_c_d');
  });

  it('keeps the stars of a cron line and of a glob', () => {
    assert.equal(plain('cron "*/3 * * * *" every 3 minutes'), 'cron "*/3 * * * *" every 3 minutes');
    assert.equal(plain('*/5 * * * * run it'), '*/5 * * * * run it');
    assert.equal(plain('match src/**/*.ts'), 'match src/**/*.ts');
    assert.equal(plain('**/*.tsx files'), '**/*.tsx files');
  });

  it('keeps a star between spaces, and one with no partner', () => {
    assert.equal(plain('2 * 3 = 6 and 4 * 5 = 20'), '2 * 3 = 6 and 4 * 5 = 20');
    assert.equal(plain('a*b and c_d'), 'a*b and c_d');
  });

  it('keeps every mark inside inline code', () => {
    assert.equal(plain('set `run_in_background` and `*/3 * * * *`'), 'set run_in_background and */3 * * * *');
    assert.equal(plain('call `a*b*c` or `__init__`'), 'call a*b*c or __init__');
  });
});

describe('emphasis', () => {
  it('drops the marks of emphasis and strong emphasis, keeping their text', () => {
    assert.equal(plain('I *really* mean _this_ and **that** and __those__'), 'I really mean this and that and those');
    assert.equal(plain('***both*** at once'), 'both at once');
    assert.equal(plain('**Note:** read it'), 'Note: read it');
  });

  it('drops a star pair inside a word, as CommonMark does, but not an underscore pair', () => {
    assert.equal(plain('un*frigging*believable'), 'unfriggingbelievable');
    assert.equal(plain('un_frigging_believable'), 'un_frigging_believable');
  });

  it('neither opens nor closes an underscore emphasis inside a word', () => {
    assert.equal(plain('my_var and other_'), 'my_var and other_');
    assert.equal(plain('_foo bar_baz'), '_foo bar_baz');
  });

  it('leaves the marks of an emphasis that cannot close', () => {
    assert.equal(plain('**not closed'), '**not closed');
    assert.equal(plain('a ** b ** c'), 'a ** b ** c');
  });
});
