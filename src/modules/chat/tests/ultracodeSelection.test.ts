import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences } from '@/shared/userSettings';
import type { LLMProvider, ProjectSession, ProviderModelsDefinition } from '@/shared/types';

/**
 * Claude Code made ultracode independent of the reasoning effort: it is a
 * session-scoped on/off switch that combines with any level, available only on
 * the xhigh-capable models. These tests pin the composer state that follows
 * from that: a legacy stored `ultracode` effort is split into xhigh plus the
 * switch, the switch is offered only for models that can run it without the
 * stored preference being destroyed elsewhere, and a session records its own
 * choice the same optimistic way it records an effort.
 */

const CLAUDE_EFFORT = {
  default: 'high',
  values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }],
};

const CLAUDE_CATALOG: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default',
      isCustom: false,
      effort: { default: 'high', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'max' }] },
    },
    { value: 'opus', label: 'Opus 5.5', isCustom: false, effort: CLAUDE_EFFORT, supportsUltracode: true },
    { value: 'sonnet', label: 'Sonnet 5.5', isCustom: false, effort: CLAUDE_EFFORT, supportsUltracode: true },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5', isCustom: false },
  ],
  DEFAULT: 'default',
  EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'],
};

type SessionSelectionData = {
  provider: LLMProvider;
  sessionId: string;
  model: string;
  effort: string | null;
  ultracode: boolean | null;
  source: 'session' | 'provider' | 'default';
};

type JsonResponse = { ok: boolean; json: () => Promise<unknown> };

const okJson = (data: unknown): Promise<JsonResponse> => Promise.resolve({
  ok: true,
  json: async () => data,
});

// Per-test knobs read by the api mock below.
const mockState: {
  catalogGate: Promise<void> | null;
  sessionSelectionGate: Promise<void> | null;
  sessionSelection: SessionSelectionData | null;
  ultracodeRequests: Array<{ provider: string; sessionId: string; ultracode: boolean }>;
  ultracodeResponse: (() => Promise<JsonResponse>) | null;
  effortResponse: (() => Promise<JsonResponse>) | null;
  modelResponse: (() => Promise<JsonResponse>) | null;
  sessionSelectionsById: Record<string, SessionSelectionData>;
  catalog: ProviderModelsDefinition;
} = {
  catalogGate: null,
  sessionSelectionGate: null,
  sessionSelection: null,
  ultracodeRequests: [],
  ultracodeResponse: null,
  effortResponse: null,
  modelResponse: null,
  sessionSelectionsById: {},
  catalog: CLAUDE_CATALOG,
};

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: async (provider: LLMProvider) => {
        if (mockState.catalogGate) {
          await mockState.catalogGate;
        }
        return okJson({ success: true, data: provider === 'claude' ? { models: mockState.catalog } : null });
      },
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: async (_provider: string, sessionId: string) => {
        // Snapshot at request time, the way the server reads the row.
        const selection = mockState.sessionSelectionsById[sessionId] ?? mockState.sessionSelection;
        if (mockState.sessionSelectionGate) {
          await mockState.sessionSelectionGate;
        }
        return okJson({ success: true, data: selection });
      },
      // Like the server: the deleted model's sessions move to the remaining
      // DEFAULT and lose their recorded effort and ultracode.
      deleteModel: (_provider: string, recordId: number) => {
        const deleted = mockState.catalog.OPTIONS.find((option) => option.recordId === recordId);
        const remaining = mockState.catalog.OPTIONS.filter((option) => option.recordId !== recordId);
        mockState.catalog = { ...mockState.catalog, OPTIONS: remaining, DEFAULT: remaining[0]?.value ?? 'default' };
        if (deleted && mockState.sessionSelection?.model === deleted.value) {
          mockState.sessionSelection = {
            ...mockState.sessionSelection,
            model: mockState.catalog.DEFAULT,
            effort: null,
            ultracode: null,
          };
        }
        return okJson({ success: true, data: { model: deleted, models: mockState.catalog } });
      },
      setSessionActiveModel: (_provider: string, _sessionId: string, model: string) => {
        if (mockState.modelResponse) {
          return mockState.modelResponse();
        }
        return okJson({ success: true, data: { ...mockState.sessionSelection, model, source: 'session' } });
      },
      setSessionActiveEffort: (_provider: string, _sessionId: string, effort: string) => {
        if (mockState.effortResponse) {
          return mockState.effortResponse();
        }
        return okJson({ success: true, data: { ...mockState.sessionSelection, effort, source: 'session' } });
      },
      setSessionActiveUltracode: (provider: string, sessionId: string, ultracode: boolean) => {
        mockState.ultracodeRequests.push({ provider, sessionId, ultracode });
        if (mockState.ultracodeResponse) {
          return mockState.ultracodeResponse();
        }
        return okJson({
          success: true,
          data: { ...mockState.sessionSelection, ultracode, source: 'session' },
        });
      },
    },
  },
}));

const SESSION: ProjectSession = { id: 'session-1', __provider: 'claude' };

const renderProviderState = async (selectedSession: ProjectSession | null = null) => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  return renderHook(() => useChatProviderState({ selectedSession, selectedProject: null }));
};

/** Renders the hook with a selected session the test can change, optionally under StrictMode. */
const renderSwitchableProviderState = async (
  initialSession: ProjectSession | null,
  options: { strict?: boolean } = {},
) => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  return renderHook(
    ({ session }: { session: ProjectSession | null }) => useChatProviderState({ selectedSession: session, selectedProject: null }),
    {
      initialProps: { session: initialSession },
      ...(options.strict ? { wrapper: StrictMode } : {}),
    },
  );
};

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  mockState.catalogGate = null;
  mockState.sessionSelectionGate = null;
  mockState.sessionSelection = null;
  mockState.ultracodeRequests = [];
  mockState.ultracodeResponse = null;
  mockState.effortResponse = null;
  mockState.modelResponse = null;
  mockState.sessionSelectionsById = {};
  mockState.catalog = CLAUDE_CATALOG;
});

/** Holds the session's active-model load until the returned release is called. */
const gateSessionSelection = (): (() => void) => {
  let release: () => void = () => undefined;
  mockState.sessionSelectionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
};

/** A response the test settles later, for requests that must stay in flight. */
const deferredResponse = () => {
  let settle: (response: JsonResponse) => void = () => undefined;
  const response = new Promise<JsonResponse>((resolve) => {
    settle = resolve;
  });
  return { response, settle };
};

afterEach(() => {
  vi.resetModules();
});

test('a stored legacy ultracode effort becomes xhigh with the ultracode switch on', async () => {
  localStorage.setItem('claude-model', 'opus');
  localStorage.setItem('claude-effort', 'ultracode');

  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  assert.equal(localStorage.getItem('claude-effort'), 'xhigh');
  assert.equal(localStorage.getItem('claude-ultracode'), 'true');
  // The catalog no longer lists `ultracode` as an effort; without the
  // migration the reconcile effect would have reset the level to default.
  assert.equal(result.current.currentProviderEffort, 'xhigh');
  assert.equal(result.current.currentProviderUltracode, true);
});

test.each(['default', 'claude-haiku-4-5', 'claude-opus-5-5-20260101'])(
  'the switch is unavailable (null) for the %s model',
  async (model) => {
    localStorage.setItem('claude-model', model);
    localStorage.setItem('claude-ultracode', 'true');

    const { result } = await renderProviderState();
    await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

    assert.equal(result.current.currentProviderUltracode, null);
  },
);

test('an xhigh-capable model shows the stored switch, off when nothing is stored', async () => {
  localStorage.setItem('claude-model', 'opus');

  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  assert.equal(result.current.currentProviderModel, 'opus');
  assert.equal(result.current.currentProviderUltracode, false);
});

test('a model that cannot run ultracode hides the switch without clearing the preference', async () => {
  localStorage.setItem('claude-model', 'claude-haiku-4-5');
  localStorage.setItem('claude-ultracode', 'true');

  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.currentProviderUltracode, null);
  assert.equal(localStorage.getItem('claude-ultracode'), 'true');

  act(() => {
    result.current.setStoredProviderModel('claude', 'opus');
  });

  assert.equal(result.current.currentProviderUltracode, true);
});

test('the switch stays offered while the catalog is still loading', async () => {
  let releaseCatalog: () => void = () => undefined;
  mockState.catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  localStorage.setItem('claude-model', 'claude-haiku-4-5');
  localStorage.setItem('claude-ultracode', 'true');

  const { result } = await renderProviderState();

  assert.equal(result.current.currentProviderUltracode, true);

  await act(async () => {
    releaseCatalog();
  });
  await waitFor(() => assert.equal(result.current.currentProviderUltracode, null));
});

test('without a session the choice becomes the per-provider default and nothing is posted', async () => {
  localStorage.setItem('claude-model', 'opus');

  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  let outcome: unknown;
  await act(async () => {
    outcome = await result.current.selectProviderUltracode('claude', true, null);
  });

  assert.deepEqual(outcome, { scope: 'default', ultracode: true });
  assert.equal(localStorage.getItem('claude-ultracode'), 'true');
  assert.equal(result.current.currentProviderUltracode, true);
  assert.equal(mockState.ultracodeRequests.length, 0);

  await act(async () => {
    await result.current.selectProviderUltracode('claude', false, null);
  });

  assert.equal(localStorage.getItem('claude-ultracode'), 'false');
  assert.equal(result.current.currentProviderUltracode, false);
});

test('an open session hydrates its recorded switch over the per-provider default', async () => {
  localStorage.setItem('claude-ultracode', 'false');
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'opus',
    effort: 'low',
    ultracode: true,
    source: 'session',
  };

  const { result } = await renderProviderState(SESSION);

  await waitFor(() => assert.equal(result.current.currentProviderUltracode, true));
  assert.equal(result.current.currentProviderModel, 'opus');
  assert.equal(result.current.currentProviderEffort, 'low');
});

test('a session with no recorded switch falls back to the per-provider default', async () => {
  localStorage.setItem('claude-ultracode', 'true');
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'opus',
    effort: null,
    ultracode: null,
    source: 'session',
  };

  const { result } = await renderProviderState(SESSION);

  await waitFor(() => assert.equal(result.current.currentProviderModel, 'opus'));
  assert.equal(result.current.currentProviderUltracode, true);
});

test('with a session the choice is shown at once, then posted to active-ultracode', async () => {
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'opus',
    effort: 'max',
    ultracode: false,
    source: 'session',
  };
  let respond: (response: JsonResponse) => void = () => undefined;
  mockState.ultracodeResponse = () => new Promise<JsonResponse>((resolve) => {
    respond = resolve;
  });

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'opus'));
  assert.equal(result.current.currentProviderUltracode, false);

  let pending: Promise<unknown> = Promise.resolve();
  act(() => {
    pending = result.current.selectProviderUltracode('claude', true, SESSION.id);
  });

  // Optimistic: on before the server answers, with model and effort untouched.
  assert.equal(result.current.currentProviderUltracode, true);
  assert.equal(result.current.currentProviderModel, 'opus');
  assert.equal(result.current.currentProviderEffort, 'max');
  assert.deepEqual(mockState.ultracodeRequests, [{ provider: 'claude', sessionId: SESSION.id, ultracode: true }]);

  let outcome: unknown;
  await act(async () => {
    respond({
      ok: true,
      json: async () => ({ success: true, data: { ...mockState.sessionSelection, ultracode: true } }),
    });
    outcome = await pending;
  });

  assert.deepEqual(outcome, { scope: 'session', ultracode: true });
  assert.equal(result.current.currentProviderUltracode, true);
  assert.equal(result.current.currentProviderEffort, 'max');
  // Like an effort pick, it also becomes the default for the next new chat.
  assert.equal(localStorage.getItem('claude-ultracode'), 'true');
});

test('a failed session update rolls the switch back to the recorded choice', async () => {
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'opus',
    effort: 'high',
    ultracode: false,
    source: 'session',
  };
  mockState.ultracodeResponse = () => Promise.resolve({
    ok: false,
    json: async () => ({ success: false, error: { message: 'boom' } }),
  });

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'opus'));

  let failure: unknown = null;
  await act(async () => {
    try {
      await result.current.selectProviderUltracode('claude', true, SESSION.id);
    } catch (error) {
      failure = error;
    }
  });

  assert.ok(failure instanceof Error);
  assert.equal(mockState.ultracodeRequests.length, 1);
  assert.equal(result.current.currentProviderUltracode, false);
  assert.equal(result.current.currentProviderModel, 'opus');
  assert.equal(result.current.currentProviderEffort, 'high');
});

test('a switch flipped while the session is still loading keeps the session\'s model and effort', async () => {
  // Per-provider defaults that must not leak into the session.
  localStorage.setItem('claude-model', 'opus');
  localStorage.setItem('claude-effort', 'low');
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'sonnet',
    effort: 'max',
    ultracode: false,
    source: 'session',
  };
  const releaseSessionSelection = gateSessionSelection();

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  await act(async () => {
    await result.current.selectProviderUltracode('claude', true, SESSION.id);
  });
  assert.deepEqual(mockState.ultracodeRequests, [{ provider: 'claude', sessionId: SESSION.id, ultracode: true }]);

  await act(async () => {
    releaseSessionSelection();
  });

  await waitFor(() => assert.equal(result.current.currentProviderModel, 'sonnet'));
  assert.equal(result.current.currentProviderEffort, 'max');
  assert.equal(result.current.currentProviderUltracode, true);
});

test('an effort picked while the session is still loading keeps the session\'s recorded switch', async () => {
  localStorage.setItem('claude-ultracode', 'false');
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'sonnet',
    effort: 'high',
    ultracode: true,
    source: 'session',
  };
  const releaseSessionSelection = gateSessionSelection();

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  await act(async () => {
    await result.current.selectProviderEffort('claude', 'low', SESSION.id);
  });
  await act(async () => {
    releaseSessionSelection();
  });

  await waitFor(() => assert.equal(result.current.currentProviderModel, 'sonnet'));
  assert.equal(result.current.currentProviderEffort, 'low');
  assert.equal(result.current.currentProviderUltracode, true);
});

test('a failed effort save does not undo a switch flipped while it was in flight', async () => {
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'opus',
    effort: 'high',
    ultracode: false,
    source: 'session',
  };
  const effortSave = deferredResponse();
  mockState.effortResponse = () => effortSave.response;

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'opus'));

  let effortOutcome: Promise<unknown> = Promise.resolve();
  act(() => {
    effortOutcome = result.current.selectProviderEffort('claude', 'max', SESSION.id).catch((error: unknown) => error);
  });
  await act(async () => {
    await result.current.selectProviderUltracode('claude', true, SESSION.id);
  });

  let failure: unknown = null;
  await act(async () => {
    effortSave.settle({ ok: false, json: async () => ({ success: false }) });
    failure = await effortOutcome;
  });

  assert.ok(failure instanceof Error);
  assert.equal(result.current.currentProviderEffort, 'high');
  assert.equal(result.current.currentProviderUltracode, true);
});

test('a switch flipped before the session loaded falls back to the loaded value when its save fails', async () => {
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'opus',
    effort: 'high',
    ultracode: false,
    source: 'session',
  };
  const releaseSessionSelection = gateSessionSelection();
  const ultracodeSave = deferredResponse();
  mockState.ultracodeResponse = () => ultracodeSave.response;

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  let ultracodeOutcome: Promise<unknown> = Promise.resolve();
  act(() => {
    ultracodeOutcome = result.current
      .selectProviderUltracode('claude', true, SESSION.id)
      .catch((error: unknown) => error);
  });
  await act(async () => {
    releaseSessionSelection();
  });
  // The load merged the pending choice over the recorded `false`.
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'opus'));
  assert.equal(result.current.currentProviderUltracode, true);

  let failure: unknown = null;
  await act(async () => {
    ultracodeSave.settle({ ok: false, json: async () => ({ success: false }) });
    failure = await ultracodeOutcome;
  });

  assert.ok(failure instanceof Error);
  assert.equal(result.current.currentProviderUltracode, false);
  assert.equal(result.current.currentProviderEffort, 'high');
});

const SESSION_B: ProjectSession = { id: 'session-2', __provider: 'claude' };

test('a failed effort save made before the load, followed by a model change, restores the recorded effort', async () => {
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'opus',
    effort: 'max',
    ultracode: true,
    source: 'session',
  };
  const releaseSessionSelection = gateSessionSelection();
  const effortSave = deferredResponse();
  mockState.effortResponse = () => effortSave.response;

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  let effortOutcome: Promise<unknown> = Promise.resolve();
  act(() => {
    effortOutcome = result.current.selectProviderEffort('claude', 'low', SESSION.id).catch((error: unknown) => error);
  });
  await act(async () => {
    await result.current.selectProviderModel('claude', 'sonnet', SESSION.id);
  });
  await act(async () => {
    releaseSessionSelection();
  });
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'sonnet'));
  assert.equal(result.current.currentProviderEffort, 'low');

  await act(async () => {
    effortSave.settle({ ok: false, json: async () => ({ success: false }) });
    await effortOutcome;
  });

  assert.equal(result.current.currentProviderModel, 'sonnet');
  assert.equal(result.current.currentProviderEffort, 'max');
  assert.equal(result.current.currentProviderUltracode, true);
});

test('the same field picked twice before the load keeps the first pick when only the second save fails', async () => {
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'opus',
    effort: 'high',
    ultracode: false,
    source: 'session',
  };
  const releaseSessionSelection = gateSessionSelection();
  const saves = [deferredResponse(), deferredResponse()];
  let saveIndex = 0;
  mockState.effortResponse = () => saves[saveIndex++].response;

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  const outcomes: Array<Promise<unknown>> = [];
  act(() => {
    outcomes.push(result.current.selectProviderEffort('claude', 'max', SESSION.id).catch((error: unknown) => error));
  });
  act(() => {
    outcomes.push(result.current.selectProviderEffort('claude', 'low', SESSION.id).catch((error: unknown) => error));
  });

  await act(async () => {
    saves[0].settle({
      ok: true,
      json: async () => ({ success: true, data: { ...mockState.sessionSelection, effort: 'max' } }),
    });
    saves[1].settle({ ok: false, json: async () => ({ success: false }) });
    await Promise.all(outcomes);
  });
  // The load was issued before both clicks and still says `high`.
  await act(async () => {
    releaseSessionSelection();
  });

  await waitFor(() => assert.equal(result.current.currentProviderModel, 'opus'));
  assert.equal(result.current.currentProviderEffort, 'max');
});

test('a choice whose save fails after the user left the session is not shown when they come back', async () => {
  mockState.sessionSelectionsById = {
    [SESSION.id]: {
      provider: 'claude',
      sessionId: SESSION.id,
      model: 'opus',
      effort: 'medium',
      ultracode: false,
      source: 'session',
    },
    [SESSION_B.id]: {
      provider: 'claude',
      sessionId: SESSION_B.id,
      model: 'sonnet',
      effort: 'high',
      ultracode: false,
      source: 'session',
    },
  };
  const releaseSessionSelection = gateSessionSelection();
  const ultracodeSave = deferredResponse();
  mockState.ultracodeResponse = () => ultracodeSave.response;

  const { result, rerender } = await renderSwitchableProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  let ultracodeOutcome: Promise<unknown> = Promise.resolve();
  act(() => {
    ultracodeOutcome = result.current
      .selectProviderUltracode('claude', true, SESSION.id)
      .catch((error: unknown) => error);
  });

  // Leave for a new chat, then for another session, while the save is in flight.
  rerender({ session: null });
  rerender({ session: SESSION_B });
  await act(async () => {
    ultracodeSave.settle({ ok: false, json: async () => ({ success: false }) });
    await ultracodeOutcome;
  });

  mockState.sessionSelectionGate = null;
  rerender({ session: SESSION });
  await act(async () => {
    releaseSessionSelection();
  });

  await waitFor(() => assert.equal(result.current.currentProviderModel, 'opus'));
  assert.equal(result.current.currentProviderEffort, 'medium');
  assert.equal(result.current.currentProviderUltracode, false);
});

test('a switch flipped while the session loads survives StrictMode double rendering', async () => {
  localStorage.setItem('claude-model', 'opus');
  localStorage.setItem('claude-effort', 'low');
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'sonnet',
    effort: 'max',
    ultracode: false,
    source: 'session',
  };
  const releaseSessionSelection = gateSessionSelection();

  const { result } = await renderSwitchableProviderState(SESSION, { strict: true });
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));

  await act(async () => {
    await result.current.selectProviderUltracode('claude', true, SESSION.id);
  });
  await act(async () => {
    releaseSessionSelection();
  });

  await waitFor(() => assert.equal(result.current.currentProviderModel, 'sonnet'));
  assert.equal(result.current.currentProviderEffort, 'max');
  assert.equal(result.current.currentProviderUltracode, true);
});

test('deleting the open session\'s custom model shows the effort and ultracode the server cleared', async () => {
  const customEffort = { default: 'high', values: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }] };
  mockState.catalog = {
    OPTIONS: [
      { value: 'my-a', label: 'A', isCustom: true, recordId: 1, effort: customEffort, supportsUltracode: true },
      { value: 'my-b', label: 'B', isCustom: true, recordId: 2, effort: customEffort, supportsUltracode: true },
    ],
    DEFAULT: 'my-a',
    EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'],
    CUSTOM_MODELS_ONLY: true,
  };
  localStorage.setItem('claude-model', 'my-b');
  localStorage.setItem('claude-effort', 'low');
  localStorage.setItem('claude-ultracode', 'false');
  mockState.sessionSelection = {
    provider: 'claude',
    sessionId: SESSION.id,
    model: 'my-a',
    effort: 'max',
    ultracode: true,
    source: 'session',
  };

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'my-a'));
  assert.equal(result.current.currentProviderEffort, 'max');
  assert.equal(result.current.currentProviderUltracode, true);

  const deletedModel = result.current.currentProviderModelOptions.find((option) => option.value === 'my-a');
  assert.ok(deletedModel);
  await act(async () => {
    await result.current.providerModelActions.remove('claude', deletedModel);
  });

  // The session now runs the fallback on the per-provider defaults, exactly
  // what a fresh load of the server row would show.
  assert.equal(result.current.currentProviderModel, 'my-b');
  assert.equal(result.current.currentProviderEffort, 'low');
  assert.equal(result.current.currentProviderUltracode, false);
});
