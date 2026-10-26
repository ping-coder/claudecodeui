import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  getPaneScopedDomId,
  hasSessionDragPayload,
  readSessionDragPayload,
  writeSessionDragPayload,
} from '@/shared/utils';
import type { SessionDragPayload } from '@/shared/types';

/**
 * The drag payload a sidebar row or pane tab carries: written under the app's own MIME type,
 * with the link kept as text/uri-list so a drop outside the app still opens the session.
 */

const SESSION_MIME = 'application/x-cloudcli-session';

/** jsdom has no DataTransfer; this keeps the parts the helpers use. */
const createDataTransfer = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? '',
  } as unknown as DataTransfer;
};

const payload: SessionDragPayload = { sessionId: 's1', projectId: 'p1', provider: 'codex', title: 'Fix the build' };

test('a written payload reads back, and the link travels as an absolute uri-list entry', () => {
  const dataTransfer = createDataTransfer();
  writeSessionDragPayload(dataTransfer, payload, '/session/s1');

  assert.deepEqual(readSessionDragPayload(dataTransfer), payload);
  const uri = dataTransfer.getData('text/uri-list');
  assert.match(uri, /^https?:\/\/.+\/session\/s1$/);
  assert.equal(dataTransfer.getData('text/plain'), uri);
});

test('without a link only the app MIME is written, and only the documented fields travel', () => {
  const dataTransfer = createDataTransfer();
  writeSessionDragPayload(dataTransfer, { ...payload, extra: 'leak' } as SessionDragPayload);

  assert.deepEqual(dataTransfer.types, [SESSION_MIME]);
  assert.equal(dataTransfer.getData(SESSION_MIME).includes('leak'), false);
});

test('a dragged tab carries where it comes from; a dragged draft has no session or project id', () => {
  const dataTransfer = createDataTransfer();
  const draftTab: SessionDragPayload = {
    sessionId: null,
    projectId: null,
    provider: 'claude',
    title: '',
    fromTab: { side: 'right', tabKey: 'tab-1' },
  };
  writeSessionDragPayload(dataTransfer, draftTab);

  assert.deepEqual(readSessionDragPayload(dataTransfer), draftTab);
});

test('a missing or malformed payload reads as null', () => {
  assert.equal(readSessionDragPayload(createDataTransfer()), null);
  for (const raw of [
    '{not json',
    'null',
    '"text"',
    JSON.stringify({ ...payload, provider: '' }),
    JSON.stringify({ ...payload, sessionId: '' }),
    JSON.stringify({ ...payload, projectId: 7 }),
    JSON.stringify({ ...payload, fromTab: { side: 'middle', tabKey: 'k' } }),
    JSON.stringify({ ...payload, fromTab: { side: 'left', tabKey: '' } }),
    JSON.stringify({ ...payload, fromTab: null }),
  ]) {
    assert.equal(readSessionDragPayload(createDataTransfer({ [SESSION_MIME]: raw })), null, raw);
  }
  const untitled = readSessionDragPayload(createDataTransfer({ [SESSION_MIME]: JSON.stringify({ ...payload, title: 5 }) }));
  assert.equal(untitled?.title, '');
});

test('only a drag carrying the app MIME counts as a session drag (files and plain links do not)', () => {
  assert.equal(hasSessionDragPayload(null), false);
  assert.equal(hasSessionDragPayload(createDataTransfer({ Files: '' })), false);
  assert.equal(hasSessionDragPayload(createDataTransfer({ 'text/uri-list': 'https://example.com' })), false);
  assert.equal(hasSessionDragPayload(createDataTransfer({ [SESSION_MIME]: '{}' })), true);
});

test('DOM ids are prefixed per pane and unchanged outside the split workspace', () => {
  assert.equal(getPaneScopedDomId('left', 'tool-result-1'), 'pane-left-tool-result-1');
  assert.equal(getPaneScopedDomId('right', 'tool-result-1'), 'pane-right-tool-result-1');
  assert.equal(getPaneScopedDomId(null, 'tool-result-1'), 'tool-result-1');
});
