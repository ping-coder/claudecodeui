import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Browser Use's full-screen preview is the browser's full screen: the button asks for the root
 * fullscreen in the click, the overlay fills the viewport edge to edge, and Escape, the browser
 * ending the fullscreen, deleting the session or the session list emptying closes it.
 */

const SESSION = {
  id: 's1',
  status: 'ready',
  url: 'https://example.com/',
  title: 'Example',
  screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
  lastAction: null,
  message: null,
  createdBy: 'agent',
  profileName: null,
  viewport: null,
  cursor: null,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const deleteSession = vi.fn(async () => json({ success: true }));
// What the next session list returns; a test empties it to play a session gone elsewhere.
const listed = { sessions: [SESSION] as typeof SESSION[] };

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      browserUse: {
        status: async () => json({ data: { enabled: true, available: true, playwrightInstalled: true, chromiumInstalled: true, installInProgress: false, sessionCount: 1, message: '' } }),
        sessions: async () => json({ data: { sessions: listed.sessions } }),
        stopSession: async () => json({ success: true }),
        deleteSession,
        installRuntime: async () => json({ success: true }),
      },
      system: { reportClientDiagnostics: async () => new Response(null, { status: 204 }) },
    },
  };
});

const { default: BrowserUsePanel } = await import('@/modules/browser-use/BrowserUsePanel');

let fullscreenElement: Element | null = null;
const requestFullscreen = vi.fn(async () => {
  fullscreenElement = document.documentElement;
  document.dispatchEvent(new Event('fullscreenchange'));
});
const exitFullscreen = vi.fn(async () => {
  fullscreenElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
});

beforeEach(() => {
  fullscreenElement = null;
  listed.sessions = [SESSION];
  requestFullscreen.mockClear();
  exitFullscreen.mockClear();
  deleteSession.mockClear();
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, writable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, writable: true, value: exitFullscreen });
});

afterEach(() => {
  for (const [target, key] of [[document, 'fullscreenEnabled'], [document, 'fullscreenElement'], [document.documentElement, 'requestFullscreen'], [document, 'exitFullscreen']] as const) {
    Reflect.deleteProperty(target, key);
  }
});

const overlay = () => document.querySelector('.fixed.inset-0.z-50');

const openPreview = async () => {
  render(<BrowserUsePanel isVisible />);
  // Without i18n set up, labels are their keys.
  const button = await screen.findByRole('button', { name: 'browserUse.fullScreen' });
  await waitFor(() => assert.equal(button.hasAttribute('disabled'), false));
  act(() => {
    fireEvent.click(button);
  });
};

test('the preview\'s full screen asks for the root fullscreen in the click and fills the viewport edge to edge', async () => {
  await openPreview();
  assert.equal(requestFullscreen.mock.calls.length, 1);
  assert.equal(requestFullscreen.mock.contexts[0] === document.documentElement, true);
  // Edge to edge from the click on, granted or not: no frame while the browser answers.
  assert.equal(overlay()?.className.includes('p-0'), true);
  assert.equal(overlay()?.className.includes('p-6'), false);
  assert.equal(overlay()?.firstElementChild?.className.includes('rounded-md'), false);
  await act(async () => undefined);
  assert.equal(overlay()?.className.includes('p-0'), true);

  act(() => {
    fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  assert.equal(overlay() === null, true);
  assert.equal(exitFullscreen.mock.calls.length, 0);
});

test('deleting the session closes the full-screen preview and leaves the browser fullscreen', async () => {
  await openPreview();
  await act(async () => undefined);

  // The delete button the narrow layout shows in the preview header.
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'browserUse.deleteSession' })[0]);
  });

  await waitFor(() => assert.equal(deleteSession.mock.calls.length, 1));
  await waitFor(() => assert.equal(overlay() === null, true));
  assert.equal(exitFullscreen.mock.calls.length, 1);
});

test('Escape closes the full-screen preview and leaves the browser fullscreen', async () => {
  await openPreview();
  await act(async () => undefined);

  act(() => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });

  assert.equal(overlay() === null, true);
  assert.equal(exitFullscreen.mock.calls.length, 1);
});

test('the session list emptying (the session deleted elsewhere) closes the preview and leaves the fullscreen', async () => {
  await openPreview();
  await act(async () => undefined);

  listed.sessions = [];
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'browserUse.refreshSessions' }));
  });

  await waitFor(() => assert.equal(overlay() === null, true));
  assert.equal(exitFullscreen.mock.calls.length, 1);
});
