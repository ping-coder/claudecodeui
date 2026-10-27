import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  collectMountedPaneIds,
  collectSessionPlacements,
  collectVisibleSessionIds,
  createInitialLayout,
  findSessionTab,
  getActiveTab,
  layoutHasSession,
  parseStoredLayout,
  serializeLayout,
  workspaceLayoutReducer as reduce,
} from '@/modules/project-workspace/utils/workspaceLayout';
import type { ProjectSession, SessionOpenTarget, WorkspaceLayout, WorkspacePaneSide } from '@/shared/types';

/**
 * The split workspace's layout reducer. The first block is the prototype suite the design was
 * verified with, rewritten for the final contract where it changed (Split opens an empty pane,
 * 'other' replaced 'side', one draft per project across both panes); the second block is the
 * final-contract suite; the third covers what the port added on top.
 */

type Action = Parameters<typeof reduce>[1];

let keySeq = 0;
const nextKey = () => `t${(keySeq += 1)}`;
let paneSeq = 0;
const nextPaneId = () => `p${(paneSeq += 1)}`;

const payload = (id: string, projectId = 'p1', extra: Partial<ProjectSession> = {}) => ({
  session: { id, summary: id.toUpperCase(), __provider: 'claude' as const, __projectId: projectId, ...extra },
  projectId,
  provider: 'claude' as const,
  title: id.toUpperCase(),
});

const open = (id: string, target: SessionOpenTarget = 'focused', preview = true, projectId = 'p1'): Action => ({
  type: 'open',
  payload: payload(id, projectId),
  target,
  preview,
  newTabKey: nextKey(),
  newPaneId: nextPaneId(),
});

const draft = (projectId = 'p1', target: SessionOpenTarget = 'focused'): Action => ({
  type: 'openDraft',
  projectId,
  provider: 'claude',
  target,
  newTabKey: nextKey(),
  newPaneId: nextPaneId(),
});

const splitAction = (): Action => ({ type: 'split', newPaneId: nextPaneId() });

const run = (...actions: Action[]): WorkspaceLayout => actions.reduce(reduce, createInitialLayout());

const paneOf = (layout: WorkspaceLayout | null, side: WorkspacePaneSide) =>
  (side === 'left' ? layout?.left : layout?.right) ?? null;

/** Tabs as `id`, `draft:<project>` and a trailing `*` for a preview. */
const ids = (layout: WorkspaceLayout | null, side: WorkspacePaneSide) =>
  paneOf(layout, side)?.tabs.map((tab) => `${tab.sessionId ?? `draft:${tab.projectId}`}${tab.isPreview ? '*' : ''}`) ?? null;

const activeId = (layout: WorkspaceLayout, side: WorkspacePaneSide) => getActiveTab(paneOf(layout, side))?.sessionId ?? null;

const tabKeyOf = (layout: WorkspaceLayout, side: WorkspacePaneSide, sessionId: string | null) =>
  paneOf(layout, side)?.tabs.find((tab) => tab.sessionId === sessionId)?.key as string;

// ---------------------------------------------------------------- prototype suite

test('single clicks reuse one preview tab per pane, in place', () => {
  const layout = run(open('a', 'focused', false), open('b'), open('c'));
  assert.deepEqual(ids(layout, 'left'), ['a', 'c*']);
  assert.equal(activeId(layout, 'left'), 'c');
  assert.equal(layout.right, null);
});

test('a double click (preview: false) on an open preview pins it', () => {
  const layout = run(open('a'), open('a', 'focused', false));
  assert.deepEqual(ids(layout, 'left'), ['a']);
});

test('opening on the other side creates the right pane and focuses it', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other'));
  assert.deepEqual(ids(layout, 'left'), ['a']);
  assert.deepEqual(ids(layout, 'right'), ['b*']);
  assert.equal(layout.focusedSide, 'right');
});

test('a plain click never duplicates: it reveals the session where it already is', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other', false), { type: 'focus', side: 'left' }, open('b'));
  assert.deepEqual(ids(layout, 'left'), ['a']);
  assert.deepEqual(ids(layout, 'right'), ['b']);
  assert.equal(layout.focusedSide, 'right');
});

test('an explicit side may show the same session on both sides', () => {
  const layout = run(open('a', 'focused', false), open('a', 'other'));
  assert.deepEqual(ids(layout, 'left'), ['a']);
  assert.deepEqual(ids(layout, 'right'), ['a*']);
  assert.deepEqual([...collectSessionPlacements(layout)], [['a', 'both']]);
});

test('Split never copies the active tab: the left keeps its Shell tab and the right starts empty', () => {
  const opened = run(open('a', 'focused', false));
  const onShell = reduce(opened, { type: 'setView', side: 'left', tabKey: opened.left.activeTabKey as string, view: 'shell', pin: true });
  const split = reduce(onShell, splitAction());
  assert.deepEqual(ids(split, 'left'), ['a']);
  assert.equal(split.left.tabs[0].view, 'shell');
  assert.deepEqual(ids(split, 'right'), []);
  assert.equal(split.focusedSide, 'right');
  // The next single click lands in the new pane.
  assert.deepEqual(ids(reduce(split, open('b')), 'right'), ['b*']);
});

test('focusing a pane that does not exist is a no-op; focusing an existing one only moves focus', () => {
  const single = run(open('a', 'focused', false));
  // Ctrl/Cmd+2 while unsplit is handled by the shortcut layer as Split, not by focus.
  assert.equal(reduce(single, { type: 'focus', side: 'right' }), single);
  const split = run(open('a', 'focused', false), open('b', 'other', false));
  const back = reduce(split, { type: 'focus', side: 'left' });
  assert.equal(back.focusedSide, 'left');
  assert.equal(back.right, split.right);
  assert.equal(back.left, split.left);
});

test('closing the active tab activates the most recently used one', () => {
  const layout = run(open('a', 'focused', false), open('b', 'focused', false), open('c', 'focused', false));
  const keyA = layout.left.tabs[0].key;
  const keyC = layout.left.tabs[2].key;
  const backToA = reduce(layout, { type: 'activate', side: 'left', tabKey: keyA });
  const toC = reduce(backToA, { type: 'activate', side: 'left', tabKey: keyC });
  const closed = reduce(toC, { type: 'close', side: 'left', tabKey: keyC });
  assert.equal(activeId(closed, 'left'), 'a');
});

test('closing the last tab of the right pane joins back to one pane', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other'));
  const closed = reduce(layout, { type: 'close', side: 'right', tabKey: layout.right?.tabs[0].key as string });
  assert.equal(closed.right, null);
  assert.equal(closed.focusedSide, 'left');
});

test('closing the last tab of the left pane promotes the right pane', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other'));
  const closed = reduce(layout, { type: 'close', side: 'left', tabKey: layout.left.tabs[0].key });
  assert.deepEqual(ids(closed, 'left'), ['b*']);
  assert.equal(closed.right, null);
  assert.equal(closed.focusedSide, 'left');
});

test("moving a pane's only tab collapses the split and keeps focus on the tab", () => {
  const layout = run(open('a', 'focused', false), open('b', 'other', false));
  const moved = reduce(layout, { type: 'move', from: 'left', tabKey: layout.left.tabs[0].key, to: 'right', newTabKey: nextKey(), newPaneId: nextPaneId() });
  assert.deepEqual(ids(moved, 'left'), ['b', 'a']);
  assert.equal(moved.right, null);
  assert.equal(activeId(moved, 'left'), 'a');
  assert.equal(moved.focusedSide, 'left');
});

test('moving onto a pane that already shows the session just reveals it', () => {
  const layout = run(open('a', 'focused', false), open('b', 'focused', false), open('a', 'other', false));
  const moved = reduce(layout, { type: 'move', from: 'left', tabKey: layout.left.tabs[0].key, to: 'right', newTabKey: nextKey(), newPaneId: nextPaneId() });
  assert.deepEqual(ids(moved, 'left'), ['b']);
  assert.deepEqual(ids(moved, 'right'), ['a']);
  assert.equal(moved.focusedSide, 'right');
});

test('a second New chat reveals the project draft instead of adding one; establishing keeps the tab key', () => {
  const layout = run(open('a', 'focused', false), draft(), draft());
  assert.deepEqual(ids(layout, 'left'), ['a', 'draft:p1']);
  const draftKey = layout.left.activeTabKey as string;
  const established = reduce(layout, { type: 'establishDraft', projectId: 'p1', payload: payload('n1') });
  assert.equal(established.left.activeTabKey, draftKey);
  assert.equal(established.left.tabs[1].key, draftKey);
  assert.deepEqual(ids(established, 'left'), ['a', 'n1']);
});

test("a pane's draft counter bumps each time a draft becomes active (feeds newSessionTrigger)", () => {
  const layout = run(open('a', 'focused', false), draft());
  assert.equal(layout.left.draftActivation, 1);
  const toA = reduce(layout, { type: 'activate', side: 'left', tabKey: layout.left.tabs[0].key });
  const backToDraft = reduce(toA, { type: 'activate', side: 'left', tabKey: layout.left.tabs[1].key });
  assert.equal(backToDraft.left.draftActivation, 2);
  // Re-activating the draft already on screen is not a new intent.
  const again = reduce(backToDraft, { type: 'activate', side: 'left', tabKey: layout.left.tabs[1].key });
  assert.equal(again, backToDraft);
  assert.equal(again.left.draftActivation, 2);
});

test('a user view switch pins the preview, and every tab remembers its own view', () => {
  const layout = run(open('a', 'focused', false), open('b'));
  const viewed = reduce(layout, { type: 'setView', side: 'left', tabKey: tabKeyOf(layout, 'left', 'b'), view: 'git', pin: true });
  assert.deepEqual(ids(viewed, 'left'), ['a', 'b']);
  assert.equal(viewed.left.tabs[1].view, 'git');
  assert.equal(viewed.left.tabs[0].view, 'chat');
});

test('rename fans out to every copy and drops the one-shot search target', () => {
  const layout = run(
    { type: 'open', payload: payload('a', 'p1', { __searchTargetSnippet: 'hit' }), target: 'focused', preview: false, newTabKey: nextKey(), newPaneId: nextPaneId() },
    open('a', 'other'),
  );
  const renamed = reduce(layout, { type: 'patchSession', sessionId: 'a', patch: { summary: 'Renamed' }, dropSearchTarget: true });
  for (const pane of [renamed.left, renamed.right]) {
    assert.equal(pane?.tabs[0].title, 'Renamed');
    assert.equal(pane?.tabs[0].session?.summary, 'Renamed');
    assert.equal(pane?.tabs[0].session ? '__searchTargetSnippet' in pane.tabs[0].session : true, false);
  }
  // Untouched sessions keep their object identity, so memoized panes do not re-render.
  assert.equal(reduce(renamed, { type: 'patchSession', sessionId: 'zzz', patch: { summary: 'x' } }), renamed);
});

test('a search hit on an already open session still hands the chat a new identity', () => {
  const layout = run(open('a', 'focused', false));
  const before = layout.left.tabs[0].session;
  const jumped = reduce(layout, {
    type: 'open',
    payload: payload('a', 'p1', { __searchTargetTimestamp: '2026-10-01' }),
    target: 'focused',
    preview: true,
    newTabKey: nextKey(),
    newPaneId: nextPaneId(),
  });
  assert.notEqual(jumped.left.tabs[0].session, before);
  assert.equal(jumped.left.tabs[0].session?.__searchTargetTimestamp, '2026-10-01');
  assert.equal(jumped.left.tabs.length, 1);
});

test('a provider alias is rewritten everywhere and never leaves two tabs for one session', () => {
  const layout = run(open('alias', 'focused', false), open('canonical', 'focused', false), open('alias', 'other', false));
  const rewritten = reduce(layout, { type: 'replaceSessionId', fromId: 'alias', toId: 'canonical' });
  assert.deepEqual(ids(rewritten, 'left'), ['canonical']);
  assert.deepEqual(ids(rewritten, 'right'), ['canonical']);
  assert.equal(rewritten.right?.tabs[0].session?.id, 'canonical');
});

test('deleting a session closes it in both panes; deleting a project closes its tabs', () => {
  const layout = run(open('a', 'focused', false), open('b', 'focused', false, 'p2'), open('a', 'other', false));
  const deleted = reduce(layout, { type: 'removeSession', sessionId: 'a' });
  assert.deepEqual(ids(deleted, 'left'), ['b']);
  assert.equal(deleted.right, null);
  const projectGone = reduce(layout, { type: 'removeProject', projectId: 'p2' });
  assert.deepEqual(ids(projectGone, 'left'), ['a']);
  assert.deepEqual(ids(projectGone, 'right'), ['a']);
});

test('visible sessions are the active tabs only; a phone sees only the focused pane', () => {
  const layout = run(open('a', 'focused', false), open('b', 'focused', false), open('c', 'other'));
  assert.deepEqual([...collectVisibleSessionIds(layout)].sort(), ['b', 'c']);
  assert.deepEqual([...collectVisibleSessionIds(layout, { focusedOnly: true })], ['c']);
});

test('closing a pane moves its conversations to the survivor without duplicates', () => {
  const layout = run(open('a', 'focused', false), open('a', 'other', false), open('b', 'right', false));
  const joined = reduce(layout, { type: 'closePane', side: 'right' });
  assert.deepEqual(ids(joined, 'left'), ['a', 'b']);
  assert.equal(joined.right, null);
  assert.equal(joined.focusedSide, 'left');
});

test('persistence round-trips without runtime session objects or counters', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other'), { type: 'setRatio', ratio: 0.65 });
  const raw = JSON.stringify(serializeLayout(layout));
  assert.equal(raw.includes('"session"'), false);
  assert.equal(raw.includes('draftActivation'), false);
  assert.equal(raw.includes('externalRevision'), false);
  const restored = parseStoredLayout(raw);
  assert.ok(restored);
  assert.deepEqual(ids(restored, 'left'), ['a']);
  assert.deepEqual(ids(restored, 'right'), ['b*']);
  assert.equal(restored.focusedSide, 'right');
  assert.equal(restored.splitRatio, 0.65);
  assert.equal(restored.left.tabs[0].session?.id, 'a');
  assert.equal(restored.left.tabs[0].session?.__projectId, 'p1');
});

test('stored layouts are validated field by field', () => {
  assert.equal(parseStoredLayout('{not json'), null);
  assert.equal(parseStoredLayout(JSON.stringify({ version: 2 })), null);
  assert.equal(parseStoredLayout(null), null);
  const restored = parseStoredLayout(JSON.stringify({
    version: 1,
    focusedSide: 'right',
    splitRatio: 7,
    left: {
      activeTabKey: 'missing',
      mru: ['k2', 42],
      tabs: [
        { key: 'k1', sessionId: 's1', projectId: 'p', provider: 'codex', title: 'One', view: 'nope', isPreview: true },
        { key: 'k1', sessionId: 's9', projectId: 'p', title: 'dup key' },
        { key: 'k2', sessionId: 's1', projectId: 'p', title: 'dup session' },
        { key: 'k3', sessionId: null, projectId: 'p', title: '', view: 'git', isPreview: true },
        { key: 'k4', sessionId: 5, projectId: 'p' },
        { key: 'k5', sessionId: 's5', projectId: '' },
      ],
    },
    right: { tabs: [] },
  }));
  assert.ok(restored);
  assert.deepEqual(restored.left.tabs.map((tab) => [tab.key, tab.view, tab.isPreview]), [['k1', 'chat', false], ['k3', 'git', true]]);
  assert.equal(restored.left.tabs[0].provider, 'codex');
  assert.equal(restored.left.activeTabKey, 'k1');
  // A pane Split just created is kept, still empty.
  assert.deepEqual(restored.right?.tabs, []);
  assert.equal(restored.focusedSide, 'right');
  assert.equal(restored.splitRatio, 0.8);
});

test('an external change reloads only the panes that show the session', () => {
  const layout = run(open('a', 'focused', false), open('b', 'focused', false), open('a', 'other', false));
  const noted = reduce(layout, { type: 'noteExternalUpdate', sessionId: 'a' });
  assert.equal(noted.left.externalRevision, 0, 'left shows b; a is only a background tab there');
  assert.equal(noted.right?.externalRevision, 1);
  assert.equal(reduce(layout, { type: 'noteExternalUpdate', sessionId: 'zzz' }), layout);
});

test('a session that no longer resolves is flagged, not silently dropped, and the flag is not persisted', () => {
  const layout = reduce(run(open('a', 'focused', false)), { type: 'markMissing', sessionId: 'a' });
  assert.equal(layout.left.tabs[0].isMissing, true);
  assert.equal(JSON.stringify(serializeLayout(layout)).includes('isMissing'), false);
  assert.equal(reduce(layout, { type: 'markMissing', sessionId: 'a' }), layout);
});

test('re-focusing the focused pane or re-activating the active tab keeps the same state object', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other', false));
  assert.equal(reduce(layout, { type: 'focus', side: 'right' }), layout);
  assert.equal(reduce(layout, { type: 'activate', side: 'right', tabKey: layout.right?.activeTabKey as string }), layout);
  assert.equal(reduce(layout, open('b')), layout, 'a plain click on the visible session changes nothing');
  assert.notEqual(reduce(layout, { type: 'focus', side: 'left' }), layout);
});

// ---------------------------------------------------------------- final-contract suite

test('split opens an empty right pane and focuses it; the next plain open lands there', () => {
  const split = run(open('a', 'focused', false), splitAction());
  assert.deepEqual(ids(split, 'right'), []);
  assert.equal(split.focusedSide, 'right');
  const opened = reduce(split, open('b'));
  assert.deepEqual(ids(opened, 'left'), ['a']);
  assert.deepEqual(ids(opened, 'right'), ['b*']);
});

test('split while split only moves focus; closePane merges without losing tabs', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other', false), open('c', 'right'));
  const refocused = reduce(layout, splitAction());
  assert.equal(refocused.focusedSide, 'left');
  assert.equal(refocused.right, layout.right);
  const merged = reduce(refocused, { type: 'closePane', side: 'right' });
  assert.equal(merged.right, null);
  assert.deepEqual(ids(merged, 'left'), ['a', 'b', 'c']);
});

test('a plain open reveals the session on the other side instead of duplicating it', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other', false), { type: 'focus', side: 'left' }, open('b'));
  assert.deepEqual(ids(layout, 'left'), ['a']);
  assert.equal(layout.focusedSide, 'right');
});

test('an absolute side may duplicate a session on purpose', () => {
  const layout = run(open('a', 'focused', false), open('a', 'right', false));
  assert.deepEqual(ids(layout, 'left'), ['a']);
  assert.deepEqual(ids(layout, 'right'), ['a']);
});

test('one unsent chat per project across the whole layout', () => {
  const layout = run(draft('p1'), open('b', 'other', false), draft('p1'));
  assert.deepEqual(ids(layout, 'left'), ['draft:p1']);
  assert.deepEqual(ids(layout, 'right'), ['b']);
  assert.equal(layout.focusedSide, 'left', 'the existing draft is revealed, not duplicated');
  const moved = reduce(layout, draft('p1', 'right'));
  // The draft was the left pane's only tab, so moving it out closes that pane.
  assert.equal(moved.right, null);
  assert.deepEqual(ids(moved, 'left'), ['b', 'draft:p1'], 'an explicit side moves the draft there');
  const withTwo = run(draft('p1'), open('a', 'focused', false), open('b', 'other', false), { type: 'focus', side: 'left' });
  const movedKeepingPane = reduce(withTwo, draft('p1', 'right'));
  assert.deepEqual(ids(movedKeepingPane, 'left'), ['a']);
  assert.deepEqual(ids(movedKeepingPane, 'right'), ['b', 'draft:p1']);
  assert.equal(movedKeepingPane.focusedSide, 'right');
  assert.equal(activeId(movedKeepingPane, 'right'), null);
});

test('establishDraft converts the project draft wherever it is, and is a no-op once it was closed', () => {
  const layout = run(draft('p1'), open('x', 'focused', false));
  const established = reduce(layout, {
    type: 'establishDraft',
    projectId: 'p1',
    payload: { session: { id: 'new', __provider: 'claude', __projectId: 'p1' }, projectId: 'p1', provider: 'claude', title: 'New' },
  });
  assert.deepEqual(ids(established, 'left'), ['new', 'x']);
  assert.equal(getActiveTab(established.left)?.sessionId, 'x', 'the active tab is untouched');
  assert.equal(established.left.tabs[0].title, 'New');
  const draftKey = layout.left.tabs[0].key;
  const closed = reduce(layout, { type: 'close', side: 'left', tabKey: draftKey });
  assert.equal(reduce(closed, {
    type: 'establishDraft',
    projectId: 'p1',
    payload: { session: { id: 'new' }, projectId: 'p1', provider: 'claude', title: '' },
  }), closed);
});

test('switching a pane onto a draft bumps draftActivation; establishing does not', () => {
  const layout = run(draft('p1'), open('x', 'focused', false));
  const before = layout.left.draftActivation;
  const back = reduce(layout, { type: 'activate', side: 'left', tabKey: layout.left.tabs[0].key });
  assert.equal(back.left.draftActivation, before + 1);
  const established = reduce(back, { type: 'establishDraft', projectId: 'p1', payload: payload('n1') });
  assert.equal(established.left.draftActivation, before + 1);
});

test('programmatic view changes keep the preview, user ones pin it', () => {
  const layout = run(open('a'));
  const tabKey = layout.left.activeTabKey as string;
  const programmatic = reduce(layout, { type: 'setView', side: 'left', tabKey, view: 'files', pin: false });
  assert.equal(programmatic.left.tabs[0].isPreview, true);
  assert.equal(programmatic.left.tabs[0].view, 'files');
  const user = reduce(layout, { type: 'setView', side: 'left', tabKey, view: 'files', pin: true });
  assert.equal(user.left.tabs[0].isPreview, false);
  assert.equal(reduce(programmatic, { type: 'setView', side: 'left', tabKey, view: 'files', pin: false }), programmatic);
});

test('copying a tab keeps the source and opens a Chat copy; copying a draft moves it', () => {
  const opened = run(open('a', 'focused', false));
  const tabKey = opened.left.activeTabKey as string;
  const onShell = reduce(opened, { type: 'setView', side: 'left', tabKey, view: 'shell', pin: true });
  const copied = reduce(onShell, { type: 'move', from: 'left', tabKey, to: 'right', copy: true, newTabKey: nextKey(), newPaneId: nextPaneId() });
  assert.deepEqual(ids(copied, 'left'), ['a']);
  assert.deepEqual(ids(copied, 'right'), ['a']);
  assert.equal(copied.right?.tabs[0].view, 'chat');
  assert.notEqual(copied.right?.tabs[0].key, tabKey);
  assert.equal(copied.left.tabs[0].view, 'shell');
  const withDraft = run(draft('p1'));
  const draftCopy = reduce(withDraft, { type: 'move', from: 'left', tabKey: withDraft.left.tabs[0].key, to: 'right', copy: true, newTabKey: nextKey(), newPaneId: nextPaneId() });
  assert.equal(draftCopy.right, null, 'the emptied left pane hands its place to the right one');
  assert.deepEqual(ids(draftCopy, 'left'), ['draft:p1']);
});

test('closing the last tab of the right pane unsplits; the empty split pane survives a reload', () => {
  const split = run(open('a', 'focused', false), splitAction());
  const restored = parseStoredLayout(JSON.stringify(serializeLayout(split)));
  assert.ok(restored?.right);
  assert.equal(restored?.focusedSide, 'right');
  const withTab = reduce(split, open('b'));
  const closed = reduce(withTab, { type: 'close', side: 'right', tabKey: withTab.right?.activeTabKey as string });
  assert.equal(closed.right, null);
  assert.equal(closed.focusedSide, 'left');
});

test('parsing keeps one draft per project and drops runtime fields', () => {
  const stored = {
    version: 1,
    left: { tabs: [{ key: 'k1', sessionId: null, projectId: 'p1', provider: 'claude', title: '', view: 'chat', isPreview: false }], activeTabKey: 'k1', mru: [] },
    right: {
      tabs: [
        { key: 'k2', sessionId: null, projectId: 'p1', provider: 'claude', title: '', view: 'bogus', isPreview: false },
        { key: 'k3', sessionId: 's', projectId: 'p1', provider: 'claude', title: 'S', view: 'git', isPreview: true },
      ],
      activeTabKey: 'k9',
      mru: ['k3'],
    },
    focusedSide: 'right',
    splitRatio: 7,
  };
  const layout = parseStoredLayout(JSON.stringify(stored));
  assert.ok(layout);
  assert.deepEqual(ids(layout, 'right'), ['s*']);
  assert.equal(layout.splitRatio, 0.8);
  assert.equal(layout.right?.activeTabKey, 'k3');
  assert.equal(layoutHasSession(layout, 's'), true);
  assert.equal(layoutHasSession(layout, 'nope'), false);
  const serialized = JSON.stringify(serializeLayout(layout));
  assert.equal(serialized.includes('"session"'), false);
  assert.equal(parseStoredLayout('{bad'), null);
});

// ---------------------------------------------------------------- additions of the port

test('a reveal switches the tab view only when one is asked for', () => {
  const opened = run(open('a', 'focused', false));
  const tabKey = opened.left.activeTabKey as string;
  const onFiles = reduce(opened, { type: 'setView', side: 'left', tabKey, view: 'files', pin: true });
  assert.equal(reduce(onFiles, open('a')), onFiles, 'a plain reveal keeps the view');
  const toChat = reduce(onFiles, { ...open('a', 'focused', false), view: 'chat' } as Action);
  assert.equal(toChat.left.tabs[0].view, 'chat');
  assert.equal(toChat.left.tabs.length, 1);
});

test('a new tab starts on the requested view; a draft can start on one too', () => {
  const layout = run({ ...open('a'), view: 'files' } as Action, { ...draft('p2'), view: 'git' } as Action);
  assert.equal(layout.left.tabs[0].view, 'files');
  assert.equal(layout.left.tabs[1].view, 'git');
});

test('findSessionTab looks in the focused pane first', () => {
  const layout = run(open('a', 'focused', false), open('a', 'other', false));
  assert.equal(findSessionTab(layout, 'a')?.side, 'right');
  assert.equal(findSessionTab(reduce(layout, { type: 'focus', side: 'left' }), 'a')?.side, 'left');
  assert.equal(findSessionTab(layout, 'b'), null);
});

test('a pane promoted into the left slot keeps its id and counters: its own chat moves along and does not reset', () => {
  // ProjectMainRegion keys panes by id, so the right pane's ChatInterface is the one that keeps
  // showing the draft; a counter bump would wipe what it shows.
  let layout = run(draft('p1'), open('a', 'focused', false));
  layout = reduce(layout, { type: 'activate', side: 'left', tabKey: layout.left.tabs[0].key });
  layout = reduce(layout, { type: 'activate', side: 'left', tabKey: layout.left.tabs[1].key });
  layout = reduce(layout, draft('p2', 'right'));
  const right = layout.right as NonNullable<typeof layout.right>;
  assert.equal(right.draftActivation, 1);
  assert.notEqual(right.id, layout.left.id);

  const promoted = reduce(layout, { type: 'closeAll', side: 'left' });
  assert.equal(promoted.right, null);
  assert.deepEqual(ids(promoted, 'left'), ['draft:p2']);
  assert.equal(promoted.left.id, right.id, 'the right pane, not the left slot, survives');
  assert.equal(promoted.left.draftActivation, right.draftActivation);
  assert.equal(promoted.left.externalRevision, right.externalRevision);

  // Closing the left side through its menu is the same move.
  const closed = reduce(layout, { type: 'closePane', side: 'left' });
  assert.equal(closed.left.id, right.id);
  assert.equal(closed.left.draftActivation, right.draftActivation);
});

test('a new pane gets the id commit generated; a restored layout gets ids that persistence never stores', () => {
  const single = run(open('a', 'focused', false));
  const split = reduce(single, { type: 'split', newPaneId: 'fresh-right' });
  assert.equal(split.left.id, single.left.id, 'the left pane keeps its id');
  assert.equal(split.right?.id, 'fresh-right');
  const opened = reduce(single, { ...open('b', 'right', false), newPaneId: 'opened-right' } as Action);
  assert.equal(opened.right?.id, 'opened-right');

  const raw = JSON.stringify(serializeLayout(split));
  assert.equal(raw.includes('fresh-right'), false, 'pane ids are runtime only');
  const restored = parseStoredLayout(raw) as WorkspaceLayout;
  assert.ok(restored.left.id && restored.right?.id);
  assert.notEqual(restored.left.id, restored.right?.id);
});

test('an alias rewrite keeps the tab that is on screen', () => {
  const layout = run(open('canonical', 'focused', false), open('x', 'focused', false), open('alias', 'focused', false));
  const aliasKey = tabKeyOf(layout, 'left', 'alias');
  const rewritten = reduce(layout, { type: 'replaceSessionId', fromId: 'alias', toId: 'canonical' });
  assert.deepEqual(ids(rewritten, 'left'), ['x', 'canonical']);
  assert.equal(rewritten.left.activeTabKey, aliasKey);
  assert.equal(reduce(layout, { type: 'replaceSessionId', fromId: 'nope', toId: 'canonical' }), layout);
});

test('a patch that changes nothing keeps the session identity', () => {
  const layout = run(open('a', 'focused', false));
  assert.equal(reduce(layout, { type: 'patchSession', sessionId: 'a', patch: { summary: 'A', __provider: 'claude' } }), layout);
  const patched = reduce(layout, { type: 'patchSession', sessionId: 'a', patch: { summary: '' } });
  assert.equal(patched.left.tabs[0].title, 'A', 'an empty summary never blanks the tab title');
});

test('reordering within a pane pins the tab; dropping it where it already is changes nothing', () => {
  const layout = run(open('a', 'focused', false), open('b', 'focused', false), open('c'));
  const cKey = tabKeyOf(layout, 'left', 'c');
  const reordered = reduce(layout, { type: 'move', from: 'left', tabKey: cKey, to: 'left', index: 0, newTabKey: nextKey(), newPaneId: nextPaneId() });
  assert.deepEqual(ids(reordered, 'left'), ['c', 'a', 'b']);
  assert.equal(reordered.left.activeTabKey, cKey);
  assert.equal(reduce(reordered, { type: 'move', from: 'left', tabKey: cKey, to: 'left', index: 0, newTabKey: nextKey(), newPaneId: nextPaneId() }), reordered);
});

test('closing the left side merges it into the right and keeps its active tab', () => {
  const layout = run(open('a', 'focused', false), open('b', 'focused', false), splitAction());
  const bKey = tabKeyOf(layout, 'left', 'b');
  const closed = reduce(layout, { type: 'closePane', side: 'left' });
  assert.equal(closed.right, null);
  assert.deepEqual(ids(closed, 'left'), ['a', 'b']);
  assert.equal(closed.left.activeTabKey, bKey);
  assert.equal(reduce(run(open('a')), { type: 'closePane', side: 'right' }).right, null);
});

test('close variants: others, to the right, all', () => {
  const layout = run(open('a', 'focused', false), open('b', 'focused', false), open('c', 'focused', false));
  const bKey = tabKeyOf(layout, 'left', 'b');
  assert.deepEqual(ids(reduce(layout, { type: 'closeOthers', side: 'left', tabKey: bKey }), 'left'), ['b']);
  assert.deepEqual(ids(reduce(layout, { type: 'closeToRight', side: 'left', tabKey: bKey }), 'left'), ['a', 'b']);
  const cleared = reduce(layout, { type: 'closeAll', side: 'left' });
  assert.deepEqual(ids(cleared, 'left'), []);
  assert.equal(cleared.left.activeTabKey, null);
  assert.equal(reduce(layout, { type: 'closeOthers', side: 'left', tabKey: 'unknown' }), layout);
});

test('pinning only acts on a preview', () => {
  const layout = run(open('a'));
  const tabKey = layout.left.activeTabKey as string;
  const pinned = reduce(layout, { type: 'pin', side: 'left', tabKey });
  assert.deepEqual(ids(pinned, 'left'), ['a']);
  assert.equal(reduce(pinned, { type: 'pin', side: 'left', tabKey }), pinned);
});

test('drafts of projects that are gone are pruned from both panes', () => {
  const layout = run(draft('p1'), open('a', 'focused', false), draft('p2', 'other'));
  const pruned = reduce(layout, { type: 'pruneDrafts', liveProjectIds: new Set(['p1']) });
  assert.deepEqual(ids(pruned, 'left'), ['draft:p1', 'a']);
  assert.equal(pruned.right, null);
  assert.equal(reduce(pruned, { type: 'pruneDrafts', liveProjectIds: new Set(['p1']) }), pruned);
});

test('the split ratio is clamped and an unchanged ratio is a no-op', () => {
  const layout = run(open('a', 'focused', false));
  assert.equal(reduce(layout, { type: 'setRatio', ratio: 0.05 }).splitRatio, 0.2);
  assert.equal(reduce(layout, { type: 'setRatio', ratio: Number.NaN }), layout);
  assert.equal(reduce(layout, { type: 'setRatio', ratio: 0.5 }), layout);
});

test('persisting a pane with more than 30 tabs keeps the most recently used ones', () => {
  let layout = createInitialLayout();
  for (let index = 0; index < 35; index += 1) {
    layout = reduce(layout, open(`s${index}`, 'focused', false));
  }
  // s0 is the oldest tab but was used last: it must survive the cap.
  layout = reduce(layout, { type: 'activate', side: 'left', tabKey: tabKeyOf(layout, 'left', 's0') });
  const stored = serializeLayout(layout);
  assert.equal(stored.left.tabs.length, 30);
  assert.equal(stored.left.activeTabKey, tabKeyOf(layout, 'left', 's0'));
  assert.ok(stored.left.tabs.some((tab) => tab.sessionId === 's0'));
  assert.ok(!stored.left.tabs.some((tab) => tab.sessionId === 's1'), 'the least recently used tabs are dropped');
  assert.ok(stored.left.mru.every((key) => stored.left.tabs.some((tab) => tab.key === key)));
});

// ---------------------------------------------------------------- review fixes

test('merging keeps the focused pane: its id, its active tab and its tabs after the left ones', () => {
  // a1 on the left; b on the right, focused, with a1 open there too.
  let layout = run(open('a1', 'focused', false), open('a2', 'focused', false), open('b', 'other', false), open('a1', 'right', false));
  layout = reduce(layout, { type: 'activate', side: 'right', tabKey: tabKeyOf(layout, 'right', 'b') });
  const rightId = layout.right?.id;
  const bKey = tabKeyOf(layout, 'right', 'b');

  const merged = reduce(layout, { type: 'merge' });
  assert.equal(merged.right, null);
  assert.equal(merged.focusedSide, 'left');
  assert.equal(merged.left.id, rightId, 'the pane the user works in stays mounted');
  assert.equal(merged.left.activeTabKey, bKey, 'the conversation on screen stays on screen');
  assert.deepEqual(ids(merged, 'left'), ['a2', 'b', 'a1'], 'left tabs first; a session open twice keeps the focused pane\'s tab');

  // Focused on the left, the left pane stays, as before.
  const fromLeft = reduce({ ...layout, focusedSide: 'left' }, { type: 'merge' });
  assert.equal(fromLeft.left.id, layout.left.id);
  assert.equal(getActiveTab(fromLeft.left)?.sessionId, getActiveTab(layout.left)?.sessionId);
  assert.deepEqual(ids(fromLeft, 'left'), ['a1', 'a2', 'b']);
});

test('merging from an empty focused pane keeps the other pane', () => {
  const layout = run(open('a', 'focused', false), splitAction());
  assert.equal(layout.focusedSide, 'right');
  const merged = reduce(layout, { type: 'merge' });
  assert.equal(merged.left.id, layout.left.id);
  assert.deepEqual(ids(merged, 'left'), ['a']);
  assert.equal(reduce(run(open('a')), { type: 'merge' }).right, null, 'nothing to merge while unsplit');
});

test('an open naming the project revives a tab flagged missing; one without a project leaves it flagged', () => {
  const flagged = reduce(run(open('gone', 'focused', false)), { type: 'markMissing', sessionId: 'gone' });
  const stranded = { ...flagged, left: { ...flagged.left, tabs: flagged.left.tabs.map((tab) => ({ ...tab, projectId: '' })) } };

  const unresolved = reduce(stranded, { ...open('gone', 'focused', true), payload: { ...payload('gone'), projectId: '' } } as Action);
  assert.equal(unresolved.left.tabs[0].isMissing, true);

  const revived = reduce(stranded, { ...open('gone', 'focused', true), payload: payload('gone', 'p9', { summary: 'Back again' }) } as Action);
  const tab = revived.left.tabs[0];
  assert.equal(tab.isMissing, undefined);
  assert.equal(tab.projectId, 'p9');
  assert.equal(tab.session?.summary, 'Back again');
  assert.equal(tab.key, stranded.left.tabs[0].key, 'the same tab comes back');

  // Open on both sides and flagged on both: one open brings back every copy.
  const both = reduce(run(open('twice', 'focused', false), open('twice', 'other', false)), { type: 'markMissing', sessionId: 'twice' });
  const bothRevived = reduce(both, { ...open('twice', 'focused', true), payload: payload('twice', 'p9') } as Action);
  assert.deepEqual([bothRevived.left.tabs[0].isMissing, bothRevived.right?.tabs[0].isMissing], [undefined, undefined]);
});

test('a patch from an authoritative row settles the tab\'s project and provider and clears a missing flag', () => {
  // A fork once opened under the project of whatever tab was on screen.
  const layout = run(open('fork', 'focused', false, 'wrong'));
  const missing = reduce(layout, { type: 'markMissing', sessionId: 'fork' });

  const patched = reduce(missing, {
    type: 'patchSession',
    sessionId: 'fork',
    patch: { id: 'fork', summary: 'Fork', __projectId: 'right-project', __provider: 'codex' },
  });
  const tab = patched.left.tabs[0];
  assert.equal(tab.projectId, 'right-project');
  assert.equal(tab.provider, 'codex');
  assert.equal(tab.isMissing, undefined);

  // A rename names no project: the tab's project and flag are left alone.
  const renamed = reduce(missing, { type: 'patchSession', sessionId: 'fork', patch: { summary: 'Renamed' } });
  assert.equal(renamed.left.tabs[0].projectId, 'wrong');
  assert.equal(renamed.left.tabs[0].isMissing, true);
});

test('establishing by draft key converts only that draft, wherever it went, and nothing once it was closed', () => {
  const establish = (draftTabKey: string): Action => ({
    type: 'establishDraft',
    projectId: 'p1',
    draftTabKey,
    payload: payload('s-new'),
  });
  const layout = run(draft('p1'), open('a', 'focused', false));
  const firstDraftKey = tabKeyOf(layout, 'left', null);

  // The user switched tabs and moved the draft to the other side meanwhile: it is still found.
  const moved = reduce(layout, { type: 'move', from: 'left', tabKey: firstDraftKey, to: 'right', newTabKey: nextKey(), newPaneId: nextPaneId() });
  const converted = reduce(moved, establish(firstDraftKey));
  assert.deepEqual(ids(converted, 'right'), ['s-new']);

  // Closed, then a new draft of the same project opened: the late establish leaves the new one alone.
  const closed = reduce(layout, { type: 'close', side: 'left', tabKey: firstDraftKey });
  const reopened = reduce(closed, draft('p1'));
  const late = reduce(reopened, establish(firstDraftKey));
  assert.equal(late, reopened);
  assert.deepEqual(ids(late, 'left'), ['a', 'draft:p1']);
});

test('an open with focus false lands in its pane without taking the focus', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other', false), { type: 'focus', side: 'left' });
  const background = reduce(layout, { ...open('fork', 'right', false), focus: false } as Action);
  assert.equal(background.focusedSide, 'left');
  assert.deepEqual(ids(background, 'right'), ['b', 'fork']);
  assert.equal(getActiveTab(background.right)?.sessionId, 'fork');

  // Revealing a tab already open over there does not move the focus either, and changes nothing else.
  const again = reduce(background, { ...open('fork', 'right', false), focus: false } as Action);
  assert.equal(again, background);
});

test('the mounted panes: both on desktop, the focused one only on a phone', () => {
  const layout = run(open('a', 'focused', false), open('b', 'other', false));
  const leftId = layout.left.id;
  const rightId = layout.right?.id as string;
  assert.deepEqual(collectMountedPaneIds(layout, { isMobile: false }), [leftId, rightId]);
  assert.deepEqual(collectMountedPaneIds(layout, { isMobile: true }), [rightId]);
  assert.deepEqual(collectMountedPaneIds(run(open('a')), { isMobile: true }), [run(open('a')).left.id]);
});
