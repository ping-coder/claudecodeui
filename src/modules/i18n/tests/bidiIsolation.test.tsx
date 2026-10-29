import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { Trans } from 'react-i18next';
import { afterAll, afterEach, beforeAll, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import { FSI, installIsolateFreeCopy, LRI, PDI } from '@/modules/i18n/bidi';
import { stripBidiIsolates } from '@/shared/direction';

/**
 * In a right-to-left language every interpolated value is isolated (FSI…PDI) and a
 * string that fell back to English is isolated left-to-right (LRI…PDI), so a path,
 * a shortcut or an English sentence keeps its own order. Plain numbers stay bare.
 * Every other language gets the strings exactly as before.
 *
 * The strings live in a namespace of their own, so the tests do not depend on what
 * the real locale files say.
 */
const NS = 'bidiTest';
const he = {
  renamed: 'שם שונה מ-{{path}}',
  progress: 'סוכנים: {{done}}/{{count}}',
  percent: '{{percent}}%',
  delta: 'שינוי: {{delta}}',
  more_one: '\u2066+{{count}}\u2069 נוסף',
  more_two: '\u2066+{{count}}\u2069 נוספים',
  more_other: '\u2066+{{count}}\u2069 נוספים',
  list: 'עבור {{providers, list}} מוצגים רק המודלים שלך',
  summary_one: 'קובץ אחד שונה מול <ref>{{base}}</ref>',
  summary_two: 'שני קבצים שונו מול <ref>{{base}}</ref>',
  summary_other: '{{count}} קבצים שונו מול <ref>{{base}}</ref>',
};
const en = {
  renamed: 'renamed from {{path}}',
  onlyEnglish: 'Delete permanently.',
  withValue: 'New chat in {{project}}.',
  agents: '{{done}}/{{count}} agents',
};
const zh = { renamed: '从 {{path}} 重命名' };

beforeAll(async () => {
  i18n.addResourceBundle('he', NS, he);
  i18n.addResourceBundle('en', NS, en);
  i18n.addResourceBundle('zh-CN', NS, zh);
  await i18n.changeLanguage('he');
});

afterEach(async () => {
  if (i18n.language !== 'he') await i18n.changeLanguage('he');
});

afterAll(async () => {
  for (const lng of ['he', 'en', 'zh-CN']) i18n.removeResourceBundle(lng, NS);
  await i18n.changeLanguage('en');
});

const t = (key: string, options?: Record<string, unknown>) => String(i18n.t(`${NS}:${key}`, options));

test('a value keeps its own order inside a Hebrew sentence', () => {
  assert.equal(t('renamed', { path: '/src/app.ts' }), `שם שונה מ-${FSI}/src/app.ts${PDI}`);
  assert.equal(t('delta', { delta: -3 }), `שינוי: ${FSI}-3${PDI}`);
});

test('a plain number stays bare, so the "%" and "/" next to it still attach', () => {
  assert.equal(t('progress', { done: 2, count: 5 }), 'סוכנים: 2/5');
  assert.equal(t('progress', { done: '2', count: '5' }), 'סוכנים: 2/5');
  assert.equal(t('percent', { percent: 45 }), '45%');
});

test('the count still picks the Hebrew plural form', () => {
  assert.deepEqual(
    [1, 2, 3].map((count) => t('more', { count })),
    [`${LRI}+1${PDI} נוסף`, `${LRI}+2${PDI} נוספים`, `${LRI}+3${PDI} נוספים`],
  );
});

test('a list is isolated item by item', () => {
  const text = t('list', { providers: ['Claude', 'Cursor', 'Codex'] });
  assert.equal(text.includes(`${FSI}Claude${PDI}`), true);
  assert.equal(text.includes(`${FSI}Codex${PDI}`), true);
  assert.equal(stripBidiIsolates(text).includes('Claude, Cursor'), true);
});

test('an English fallback is isolated left-to-right, its values too', () => {
  assert.equal(t('onlyEnglish'), `${LRI}Delete permanently.${PDI}`);
  assert.equal(t('nowhere', { defaultValue: 'Not translated yet.' }), `${LRI}Not translated yet.${PDI}`);
  assert.equal(t('withValue', { project: 'demo-app' }), `${LRI}New chat in ${FSI}demo-app${PDI}.${PDI}`);
});

test('a value inside a Trans component is isolated too', () => {
  render(<Trans i18nKey={`${NS}:summary`} count={2} values={{ base: 'feature/x' }} components={{ ref: <span data-testid="ref" /> }} />);
  assert.equal(screen.getByTestId('ref').textContent, `${FSI}feature/x${PDI}`);
});

test('a per-call interpolation option keeps the isolation', () => {
  assert.equal(t('renamed', { path: 'a/b', interpolation: { escapeValue: false } }), `שם שונה מ-${FSI}a/b${PDI}`);
});

test('left-to-right languages get the strings unchanged', async () => {
  await i18n.changeLanguage('zh-CN');
  assert.equal(t('renamed', { path: '/src/app.ts' }), '从 /src/app.ts 重命名');
  assert.equal(t('onlyEnglish'), 'Delete permanently.');
  await i18n.changeLanguage('en');
  assert.equal(t('withValue', { project: 'demo-app' }), 'New chat in demo-app.');
  assert.equal(t('agents', { done: 2, count: 5 }), '2/5 agents');
});

test('stripBidiIsolates gives back the plain text and keeps other marks', () => {
  assert.equal(stripBidiIsolates(`${LRI}New chat in ${FSI}demo-app${PDI}.${PDI}`), 'New chat in demo-app.');
  assert.equal(stripBidiIsolates('\u200Fשלום\u200E'), '\u200Fשלום\u200E');
});

/** Selects `target` (a node's contents, or a range), fires a copy event from it, and reports what a listener put on the clipboard. */
function copyFrom(target: Node | Range, { prevented = false } = {}) {
  let range = target;
  if (!(range instanceof Range)) {
    range = document.createRange();
    range.selectNodeContents(target as Node);
  }
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const written: Record<string, string> = {};
  // jsdom has no ClipboardEvent: a plain event with a clipboardData stand-in reaches the same listener.
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => { written[type] = value; } } });
  if (prevented) event.preventDefault();
  range.startContainer.dispatchEvent(event);
  selection.removeAllRanges();
  return { written, cancelled: event.defaultPrevented };
}

/**
 * Fires a dragstart from `source` with `data` already in the dataTransfer, as a browser fills it
 * for a dragged selection, and reports the data once the listeners ran.
 */
function dragFrom(source: Node, data: Record<string, string>, { prevented = false } = {}) {
  const store = { ...data };
  // jsdom has no DragEvent: a plain event with a dataTransfer stand-in reaches the same listener.
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { getData: (type: string) => store[type] ?? '', setData: (type: string, value: string) => { store[type] = value; } },
  });
  if (prevented) event.preventDefault();
  source.dispatchEvent(event);
  return store;
}

const dragged = { 'text/plain': `${FSI}claude login${PDI}`, 'text/html': `<code>${FSI}claude login${PDI}</code>` };
const untouched = (store: Record<string, string>) =>
  store['text/plain'] === dragged['text/plain'] && store['text/html'] === dragged['text/html'];

function hint() {
  const paragraph = document.createElement('p');
  paragraph.innerHTML = `יש להריץ את <code>${FSI}claude login${PDI}</code> פעם אחת בטרמינל.`;
  document.body.append(paragraph);
  return paragraph;
}

test('a copy by hand leaves the isolates behind in a right-to-left interface', () => {
  const paragraph = hint();
  const { written, cancelled } = copyFrom(paragraph.querySelector('code')!);
  paragraph.remove();
  assert.equal(cancelled, true);
  assert.equal(written['text/plain'], 'claude login');
  assert.equal(written['text/html'], 'claude login');
});

test('a copy is left to the browser in a left-to-right interface, from a field, or after another handler', async () => {
  const paragraph = hint();
  const code = paragraph.querySelector('code')!;
  const textarea = document.createElement('textarea');
  document.body.append(textarea);
  textarea.focus();
  const fromField = copyFrom(code);
  textarea.remove();
  const handled = copyFrom(code, { prevented: true });
  await i18n.changeLanguage('en');
  const leftToRight = copyFrom(code);
  paragraph.remove();
  assert.deepEqual([fromField, handled, leftToRight].map(({ written }) => Object.keys(written).length), [0, 0, 0]);
  assert.deepEqual([fromField.cancelled, leftToRight.cancelled], [false, false]);
});

test('the copied HTML leaves out what the screen does not show, as the browser would', () => {
  const box = document.createElement('div');
  box.innerHTML = [
    `<p>שימוש: ${FSI}2m 15s${PDI} <strong>bold</strong> <span style="color: red">const</span></p>`,
    '<details><summary>script</summary><pre>HIDDEN_SCRIPT</pre></details>',
    '<details open><summary>result</summary><p>OPEN_RESULT</p></details>',
    '<p><span style="display: none">HIDDEN_SPAN</span><span style="visibility: hidden">INVISIBLE<b style="visibility: visible">SHOWN_CHILD</b></span></p>',
    '<p><span style="user-select: none"><svg data-icon=""></svg>GUTTER<span style="user-select: text">SELECTABLE</span></span> line</p>',
    '<p><span style="user-select: none"><img src="/icon.png" alt="">TRIGGER_TITLE</span></p>',
    '<div style="overflow: hidden"><pre>COLLAPSED_OUTPUT</pre></div>',
    '<div style="overflow: hidden" id="truncated">TRUNCATED_TITLE</div>',
    '<div id="skipped">CONTENT_VISIBILITY_HIDDEN</div><div style="display: contents" id="contents"><span>INSIDE_CONTENTS</span></div>',
    '<p><a href="/session/abc">link</a> <img src="/logo.svg" alt="logo"></p>',
  ].join('');
  document.body.append(box);
  // jsdom lays nothing out, so every box measures 0×0, as a collapsed section does; the title has room.
  box.querySelector('#truncated')!.getBoundingClientRect = () => ({ width: 200, height: 20 }) as DOMRect;
  // jsdom has no checkVisibility(). Chromium's says false for what content-visibility: hidden skips,
  // and for a display: contents element, which has no box of its own though its children show.
  box.querySelector('#skipped')!.checkVisibility = () => false;
  box.querySelector('#contents')!.checkVisibility = () => false;
  const { written } = copyFrom(box);
  box.remove();
  const html = written['text/html'] ?? '';
  const hidden = [
    'HIDDEN_SCRIPT', 'HIDDEN_SPAN', 'INVISIBLE', 'data-icon', 'GUTTER', 'TRIGGER_TITLE', 'icon.png', 'COLLAPSED_OUTPUT', 'CONTENT_VISIBILITY_HIDDEN',
  ];
  const shown = [
    `שימוש: 2m 15s <strong>bold</strong> <span style="color: red">const</span>`,
    '<summary>script</summary>', 'OPEN_RESULT', 'SHOWN_CHILD', 'SELECTABLE', 'TRUNCATED_TITLE', 'INSIDE_CONTENTS',
    `href="${new URL('/session/abc', document.baseURI).href}"`, `src="${new URL('/logo.svg', document.baseURI).href}"`,
  ];
  assert.deepEqual(hidden.filter((text) => html.includes(text)), []);
  assert.deepEqual(shown.filter((text) => !html.includes(text)), []);
  assert.equal(/[\u2066-\u2069]/.test(html + written['text/plain']), false);
});

test('with nothing hidden, the copied HTML is the selected markup without its isolates', () => {
  const box = document.createElement('div');
  box.innerHTML = `<p>ראשון ${FSI}src/one.ts${PDI} עוד</p><ul><li><em>item</em> one</li><li>two <code>${FSI}x${PDI}</code></li></ul><p>אחרון ${FSI}two${PDI} סוף</p>`;
  document.body.append(box);
  const [first, list, last] = [...box.children];
  const [item, code] = [list.querySelector('li')!, list.querySelector('code')!];
  const rangeOf = (startNode: Node, startOffset: number, endNode: Node, endOffset: number) => {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  };
  const ranges = [
    rangeOf(first.firstChild!, 3, last.firstChild!, 9),
    rangeOf(first.firstChild!, 4, first.firstChild!, 18),
    // One starts after the first children of its levels, one ends before the last ones.
    rangeOf(item.lastChild!, 1, code.firstChild!, 2),
    rangeOf(first.firstChild!, 3, item.firstChild!.firstChild!, 2),
    // Boundaries between children: from the second item to the end of the list.
    rangeOf(list, 1, box, 2),
  ];
  const cloned = ranges.map((range) => {
    const clone = document.createElement('div');
    clone.append(range.cloneContents());
    return stripBidiIsolates(clone.innerHTML);
  });
  const copied = ranges.map((range) => copyFrom(range).written['text/html']);
  box.remove();
  assert.deepEqual(copied, cloned);
});

test('a dragged selection leaves the isolates behind in a right-to-left interface', () => {
  const paragraph = hint();
  const store = dragFrom(paragraph.querySelector('code')!.firstChild!, dragged);
  paragraph.remove();
  assert.equal(store['text/plain'], 'claude login');
  assert.equal(store['text/html'], '<code>claude login</code>');
});

test('a drag is left alone in a left-to-right interface, from a field or an editor, or after another handler', async () => {
  const paragraph = hint();
  const command = paragraph.querySelector('code')!.firstChild!;
  const textarea = document.createElement('textarea');
  // A read-only CodeMirror view is contenteditable="false"; its dragstart handler writes the file's text.
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'false');
  editor.innerHTML = `<div class="cm-line">${FSI}typed${PDI}</div>`;
  document.body.append(textarea, editor);
  const stores = [dragFrom(textarea, dragged), dragFrom(editor.firstChild!.firstChild!, dragged), dragFrom(command, dragged, { prevented: true })];
  await i18n.changeLanguage('en');
  stores.push(dragFrom(command, dragged));
  paragraph.remove();
  textarea.remove();
  editor.remove();
  assert.deepEqual(stores.map(untouched), [true, true, true, true]);
});

test('the function installIsolateFreeCopy returns removes both listeners', async () => {
  // In English the app's own listeners stay out of the way.
  await i18n.changeLanguage('en');
  const remove = installIsolateFreeCopy({ dir: () => 'rtl', resolvedLanguage: 'he', language: 'he' } as unknown as typeof i18n);
  const paragraph = hint();
  const code = paragraph.querySelector('code')!;
  const handled = () => [copyFrom(code).cancelled, !untouched(dragFrom(code.firstChild!, dragged))];
  const installed = handled();
  remove();
  const removed = handled();
  paragraph.remove();
  assert.deepEqual([installed, removed], [[true, true], [false, false]]);
});
