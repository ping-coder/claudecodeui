import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useWorkspaceLayout } from '@/modules/project-workspace/hooks/useWorkspaceLayout';
import { parseStoredLayout, workspaceLayoutReducer as reduce } from '@/modules/project-workspace/utils/workspaceLayout';
import { WORKSPACE_LAYOUT_STORAGE_KEY } from '@/shared/constants';
import type { WorkspaceLayout } from '@/shared/types';

/**
 * Where a page's pane layout comes from and where it goes: sessionStorage is the browser tab's
 * own copy, localStorage the seed a new page starts from, and only real changes are written.
 */

type StoredTabInput = {
  key: string;
  sessionId: string | null;
  projectId?: string;
  view?: string;
  isPreview?: boolean;
};

const storedTab = ({ key, sessionId, projectId = 'p1', view = 'chat', isPreview = false }: StoredTabInput) => ({
  key,
  sessionId,
  projectId,
  provider: 'claude',
  title: sessionId ? sessionId.toUpperCase() : '',
  view,
  isPreview,
});

const storedPane = (tabs: ReturnType<typeof storedTab>[], activeTabKey: string | null = tabs[0]?.key ?? null) => ({
  tabs,
  activeTabKey,
  mru: activeTabKey ? [activeTabKey] : [],
});

const storedLayout = (
  left: ReturnType<typeof storedPane>,
  right: ReturnType<typeof storedPane> | null = null,
  extra: Record<string, unknown> = {},
) => JSON.stringify({ version: 1, left, right, focusedSide: 'left', splitRatio: 0.5, ...extra });

const sessionIdsOf = (layout: WorkspaceLayout | null, side: 'left' | 'right' = 'left') =>
  (side === 'left' ? layout?.left : layout?.right)?.tabs.map((tab) => tab.sessionId ?? `draft:${tab.projectId}`) ?? null;

const renderLayout = (initialSessionId?: string) => renderHook(() => useWorkspaceLayout({ initialSessionId }));

const openAction = (id: string, newTabKey: string) => ({
  type: 'open' as const,
  payload: { session: { id, summary: id, __provider: 'claude' as const, __projectId: 'p1' }, projectId: 'p1', provider: 'claude' as const, title: id },
  target: 'focused' as const,
  preview: false,
  newTabKey,
  newPaneId: `pane-for-${newTabKey}`,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

test('this browser tab\'s own sessionStorage layout wins over the localStorage seed', () => {
  sessionStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, storedLayout(storedPane([storedTab({ key: 'own', sessionId: 'mine' })])));
  localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, storedLayout(storedPane([storedTab({ key: 'seed', sessionId: 'seeded' })])));

  const { result } = renderLayout('seeded');

  assert.deepEqual(sessionIdsOf(result.current.layout), ['mine']);
});

test('the localStorage seed applies on / and when it holds the URL session', () => {
  localStorage.setItem(
    WORKSPACE_LAYOUT_STORAGE_KEY,
    storedLayout(storedPane([storedTab({ key: 'k1', sessionId: 'a' })]), storedPane([storedTab({ key: 'k2', sessionId: 'b' })])),
  );

  const onRoot = renderLayout();
  assert.deepEqual(sessionIdsOf(onRoot.result.current.layout), ['a']);
  assert.deepEqual(sessionIdsOf(onRoot.result.current.layout, 'right'), ['b']);
  onRoot.unmount();

  const onSeededSession = renderLayout('b');
  assert.deepEqual(sessionIdsOf(onSeededSession.result.current.layout, 'right'), ['b']);
});

test('a deep link the seed does not hold starts one empty pane, not another tab\'s whole layout', () => {
  localStorage.setItem(
    WORKSPACE_LAYOUT_STORAGE_KEY,
    storedLayout(storedPane([storedTab({ key: 'k1', sessionId: 'a' })]), storedPane([storedTab({ key: 'k2', sessionId: 'b' })])),
  );

  const { result } = renderLayout('elsewhere');

  assert.deepEqual(result.current.layout.left.tabs, []);
  assert.equal(result.current.layout.right, null);
});

test('an empty pane Split just made survives a reload; an empty left pane hands its place to the right one', () => {
  const withEmptyRight = parseStoredLayout(storedLayout(
    storedPane([storedTab({ key: 'k1', sessionId: 'a' })]),
    storedPane([]),
    { focusedSide: 'right' },
  ));
  assert.deepEqual(withEmptyRight?.right?.tabs, []);
  assert.equal(withEmptyRight?.focusedSide, 'right');

  const withEmptyLeft = parseStoredLayout(storedLayout(
    storedPane([]),
    storedPane([storedTab({ key: 'k2', sessionId: 'b' })]),
    { focusedSide: 'right' },
  ));
  assert.deepEqual(sessionIdsOf(withEmptyLeft), ['b']);
  assert.equal(withEmptyLeft?.right, null);
  assert.equal(withEmptyLeft?.focusedSide, 'left');
});

test('stored fields are validated one by one, with every cap applied', () => {
  const manyTabs = Array.from({ length: 31 }, (_, index) => storedTab({ key: `k${index}`, sessionId: `s${index}` }));
  const restored = parseStoredLayout(JSON.stringify({
    version: 1,
    focusedSide: 'sideways',
    splitRatio: 0.05,
    left: {
      tabs: [
        ...manyTabs.slice(0, 3),
        storedTab({ key: 'p-a', sessionId: 'pa', isPreview: true }),
        storedTab({ key: 'p-b', sessionId: 'pb', isPreview: true }),
        storedTab({ key: 'k0', sessionId: 'duplicate-key' }),
        storedTab({ key: 'dup-session', sessionId: 's1' }),
        storedTab({ key: 'draft-1', sessionId: null, projectId: 'p1' }),
        ...manyTabs.slice(3),
      ],
      activeTabKey: 'k2',
      mru: ['nope', 'k1', 'k1'],
    },
    right: {
      tabs: [
        storedTab({ key: 'draft-2', sessionId: null, projectId: 'p1' }),
        storedTab({ key: 'k-right', sessionId: 's1' }),
        { key: 'bad-view', sessionId: 'sv', projectId: 'p1', view: 'plugin:' },
      ],
      activeTabKey: 'draft-2',
      mru: [],
    },
  }));
  assert.ok(restored);

  // 30 raw entries are read per pane; the two invalid ones among them are dropped, not replaced.
  assert.equal(restored.left.tabs.length, 28);
  assert.ok(restored.left.tabs.some((tab) => tab.key === 'k24'));
  assert.ok(!restored.left.tabs.some((tab) => tab.key === 'k25'));
  assert.ok(restored.left.tabs.some((tab) => tab.key === 'draft-1'));
  assert.equal(new Set(restored.left.tabs.map((tab) => tab.key)).size, restored.left.tabs.length);
  assert.equal(restored.left.tabs.filter((tab) => tab.sessionId === 's1').length, 1);
  assert.deepEqual(restored.left.tabs.filter((tab) => tab.isPreview).map((tab) => tab.key), ['p-b']);
  assert.equal(restored.left.activeTabKey, 'k2');
  assert.deepEqual(restored.left.mru, ['k2', 'k1']);
  // One draft per project across the layout; the same session may sit on both sides.
  assert.deepEqual(sessionIdsOf(restored, 'right'), ['s1', 'sv']);
  assert.equal(restored.right?.tabs[1].view, 'chat');
  assert.equal(restored.right?.activeTabKey, 'k-right');
  assert.equal(restored.splitRatio, 0.2);
  assert.equal(restored.focusedSide, 'left');
  // Counters always start at zero.
  assert.equal(restored.left.draftActivation, 0);
  assert.equal(restored.left.externalRevision, 0);
});

test('the legacy activeTab key gives its view once and is then deleted', () => {
  localStorage.setItem('activeTab', 'files');
  const { result } = renderLayout();

  assert.equal(result.current.takeLegacyView(), 'files');
  assert.equal(localStorage.getItem('activeTab'), null);
  assert.equal(result.current.takeLegacyView(), undefined);

  localStorage.setItem('activeTab', 'not-a-view');
  assert.equal(result.current.takeLegacyView(), undefined);
  assert.equal(localStorage.getItem('activeTab'), null, 'an invalid legacy value is dropped too');
});

test('changes reach both stores after 300ms, at once on pagehide, and the starting layout is never written back', () => {
  vi.useFakeTimers();
  localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, storedLayout(storedPane([storedTab({ key: 'seed', sessionId: 'seeded' })])));
  const { result } = renderLayout('not-in-seed');

  act(() => {
    vi.advanceTimersByTime(1000);
  });
  assert.equal(sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), null, 'the page start is not a change');
  assert.ok(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)?.includes('seeded'), 'the seed other tabs start from is left alone');

  act(() => {
    result.current.setLayout(reduce(result.current.layoutRef.current, openAction('a', 'tab-a')));
  });
  act(() => {
    vi.advanceTimersByTime(299);
  });
  assert.equal(sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), null);

  act(() => {
    vi.advanceTimersByTime(1);
  });
  assert.deepEqual(sessionIdsOf(parseStoredLayout(sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY))), ['a']);
  assert.deepEqual(sessionIdsOf(parseStoredLayout(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY))), ['a']);

  act(() => {
    result.current.setLayout(reduce(result.current.layoutRef.current, openAction('b', 'tab-b')));
  });
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  assert.deepEqual(sessionIdsOf(parseStoredLayout(sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY))), ['a', 'b']);
  assert.deepEqual(sessionIdsOf(parseStoredLayout(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY))), ['a', 'b']);
});

test('runtime fields never reach storage', () => {
  vi.useFakeTimers();
  const { result } = renderLayout();

  act(() => {
    let next = reduce(result.current.layoutRef.current, openAction('a', 'tab-a'));
    next = reduce(next, { type: 'markMissing', sessionId: 'a' });
    next = reduce(next, { type: 'noteExternalUpdate', sessionId: 'a' });
    result.current.setLayout(next);
  });
  assert.equal(result.current.layout.left.tabs[0].isMissing, true);
  assert.equal(result.current.layout.left.externalRevision, 1);

  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  const raw = sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? '';
  assert.ok(raw.includes('"tab-a"'));
  for (const runtimeField of ['"session"', 'isMissing', 'draftActivation', 'externalRevision']) {
    assert.equal(raw.includes(runtimeField), false, `${runtimeField} must not be persisted`);
  }
});

test('setLayout keeps the ref mirror in step, so a second write in the same tick builds on the first', () => {
  const { result } = renderLayout();

  act(() => {
    result.current.setLayout(reduce(result.current.layoutRef.current, openAction('a', 'tab-a')));
    result.current.setLayout(reduce(result.current.layoutRef.current, openAction('b', 'tab-b')));
  });

  assert.deepEqual(sessionIdsOf(result.current.layout), ['a', 'b']);
  assert.equal(result.current.layoutRef.current, result.current.layout);
  const keyA = result.current.createTabKey();
  assert.notEqual(keyA, result.current.createTabKey());
});

test('what the page does on its own reaches only its own copy; the seed waits for a change the user made', () => {
  vi.useFakeTimers();
  const seed = storedLayout(storedPane([storedTab({ key: 'seed', sessionId: 'seeded' })]));
  localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, seed);
  // A deep link opened in a new browser tab: the page starts empty and opens the URL's session itself.
  const { result } = renderLayout('not-in-seed');

  act(() => {
    result.current.setLayout(reduce(result.current.layoutRef.current, openAction('linked', 'tab-linked')), { byUser: false });
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });
  assert.deepEqual(sessionIdsOf(parseStoredLayout(sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY))), ['linked']);
  assert.equal(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), seed, 'the layout new pages start from is untouched');

  act(() => {
    result.current.setLayout(reduce(result.current.layoutRef.current, { type: 'noteExternalUpdate', sessionId: 'linked' }), { byUser: false });
    window.dispatchEvent(new Event('pagehide'));
  });
  assert.equal(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), seed, 'not on pagehide either');

  act(() => {
    result.current.setLayout(reduce(result.current.layoutRef.current, openAction('mine', 'tab-mine')));
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });
  assert.deepEqual(sessionIdsOf(parseStoredLayout(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY))), ['linked', 'mine']);
});
