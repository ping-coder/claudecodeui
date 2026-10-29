import assert from 'node:assert/strict';

import { openSearchPanel } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import PRDEditor from '@/modules/prd-editor/PRDEditor';

/**
 * The PRD editor's own dialogs (the overwrite confirmation, the Generate Tasks help) take Escape
 * before anything under them and close alone: the editor stays open with what is typed in it, in
 * full screen too. The next presses go on from there: CodeMirror's search panel, the full screen,
 * then the editor. The real CodeMirror runs here and keys go to the focused element, as typed.
 */

const project: Project = { projectId: 'p1', displayName: 'Repo', fullPath: '/repo' };
const onClose = vi.fn();
// The bodies of the saves that reached the server.
const savedBodies: string[] = [];
// Holds the next save's answer back while a test needs it pending; null answers at once.
let pendingSave: Promise<void> | null = null;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let fullscreenElement: Element | null = null;
const requestFullscreen = vi.fn(async () => {
  fullscreenElement = document.documentElement;
  document.dispatchEvent(new Event('fullscreenchange'));
});
const exitFullscreen = vi.fn(async () => {
  fullscreenElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
});

beforeAll(() => {
  // jsdom lays nothing out and has no text-range rectangles; CodeMirror's cursor layer asks for them.
  const emptyRect = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => Object.assign([], { item: () => null }),
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => emptyRect });
});

beforeEach(() => {
  fullscreenElement = null;
  onClose.mockClear();
  requestFullscreen.mockClear();
  exitFullscreen.mockClear();
  savedBodies.length = 0;
  pendingSave = null;
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, writable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, writable: true, value: exitFullscreen });
  // The project already has a prd.txt, the name a new PRD gets from the task board.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('/api/taskmaster/prd/p1')) {
      return new Response(null, { status: 204 });
    }
    if (init?.method === 'POST') {
      savedBodies.push(String(init.body));
      await pendingSave;
      return json({ success: true });
    }
    return json({ prdFiles: [{ name: 'prd.txt' }] });
  }));
});

afterEach(() => {
  for (const [target, key] of [[document, 'fullscreenEnabled'], [document, 'fullscreenElement'], [document.documentElement, 'requestFullscreen'], [document, 'exitFullscreen']] as const) {
    Reflect.deleteProperty(target, key);
  }
  vi.unstubAllGlobals();
});

const getView = (container: HTMLElement): EditorView => {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement);
  if (!view) {
    throw new Error('no editor view');
  }
  return view;
};

// A new PRD named prd.txt, typed in and not saved yet; resolves once the project's PRD list is in.
const renderEditor = async () => {
  const view = render(
    <PRDEditor
      project={project}
      projectPath="/repo"
      onClose={onClose}
      isNewFile
      file={{ name: 'prd.txt', content: '' }}
      initialContent="# My unsaved PRD"
    />,
  );
  await waitFor(() => assert.equal(view.container.querySelector('.cm-content') !== null, true));
  await waitFor(() => assert.equal(vi.mocked(fetch).mock.calls.length > 0, true));
  await act(async () => undefined);
  return view;
};

// Keys go to the focused element and bubble from there, as a typed key does.
const press = (init: KeyboardEventInit) => {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, init);
  });
};

const focusEditor = (container: HTMLElement) => {
  act(() => {
    getView(container).focus();
  });
};

const isOverwriteShown = () => screen.queryByText('File Already Exists') !== null;
const isGenerateHelpShown = () => screen.queryByText('Generate Tasks from PRD') !== null;

// Ctrl+S in the editor: prd.txt exists, so the save asks first.
const saveIntoExistingName = async (container: HTMLElement) => {
  focusEditor(container);
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 's', ctrlKey: true });
  });
  await waitFor(() => assert.equal(isOverwriteShown(), true));
};

const isMaximized = (container: HTMLElement) => (container.querySelector('.fixed.inset-0')?.className ?? '').includes('md:p-0');

test('Escape on the overwrite confirmation closes it alone: the editor and what is typed in it stay', async () => {
  const { container } = await renderEditor();
  await saveIntoExistingName(container);

  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '0');
  assert.equal(isOverwriteShown(), false);
  assert.equal(String(savedBodies.length), '0');
  assert.equal(getView(container).state.doc.toString(), '# My unsaved PRD');

  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '1');
});

test('an Escape that ends an IME composition is left to it: the confirmation and the editor stay', async () => {
  const { container } = await renderEditor();
  await saveIntoExistingName(container);

  press({ key: 'Escape', isComposing: true });
  assert.equal(String(onClose.mock.calls.length), '0');
  assert.equal(isOverwriteShown(), true);

  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '0');
  assert.equal(isOverwriteShown(), false);
});

test('in full screen Escape closes the confirmation, then leaves full screen, then closes the editor', async () => {
  const { container } = await renderEditor();
  act(() => {
    fireEvent.click(screen.getByTitle('Fullscreen'));
  });
  await act(async () => undefined);
  assert.equal(isMaximized(container), true);
  await saveIntoExistingName(container);

  press({ key: 'Escape' });
  assert.equal(String(exitFullscreen.mock.calls.length), '0');
  assert.equal(String(onClose.mock.calls.length), '0');
  assert.equal(isMaximized(container), true);
  assert.equal(isOverwriteShown(), false);

  press({ key: 'Escape' });
  assert.equal(isMaximized(container), false);
  assert.equal(String(exitFullscreen.mock.calls.length), '1');
  assert.equal(String(onClose.mock.calls.length), '0');

  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '1');
});

test('Escape on the Generate Tasks help closes it alone', async () => {
  const { container } = await renderEditor();
  act(() => {
    fireEvent.click(screen.getByTitle('Generate tasks from PRD content'));
  });
  assert.equal(isGenerateHelpShown(), true);
  focusEditor(container);

  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '0');
  assert.equal(isGenerateHelpShown(), false);

  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '1');
});

test('while an overwrite is saving, Escape on the confirmation is held like its disabled Cancel', async () => {
  const { container } = await renderEditor();
  let releaseSave: () => void = () => undefined;
  pendingSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await saveIntoExistingName(container);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
  });
  assert.equal(String(savedBodies.length), '1');

  // Saved again before the overwrite answered: the confirmation is back with its Cancel disabled.
  await saveIntoExistingName(container);
  assert.equal(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled'), true);
  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '0');
  assert.equal(isOverwriteShown(), true);

  await act(async () => {
    releaseSave();
  });
  await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled'), false));
  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '0');
  assert.equal(isOverwriteShown(), false);
});

test('the confirmation takes Escape before CodeMirror\'s search panel, which takes it before the editor', async () => {
  const { container } = await renderEditor();
  const isSearchOpen = () => container.querySelector('.cm-search') !== null;
  act(() => {
    openSearchPanel(getView(container));
  });
  assert.equal(isSearchOpen(), true);
  // The search field has the focus (jsdom's select() does not move it as a browser's does); Ctrl+S
  // there saves the PRD.
  act(() => {
    (container.querySelector('.cm-search input') as HTMLInputElement).focus();
  });
  assert.equal(document.activeElement?.closest('.cm-search') != null, true);
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 's', ctrlKey: true });
  });
  await waitFor(() => assert.equal(isOverwriteShown(), true));

  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '0');
  assert.equal(isOverwriteShown(), false);
  assert.equal(isSearchOpen(), true);

  press({ key: 'Escape' });
  assert.equal(isSearchOpen(), false);
  assert.equal(String(onClose.mock.calls.length), '0');

  press({ key: 'Escape' });
  assert.equal(String(onClose.mock.calls.length), '1');
});

test('both dialogs are modal dialogs named by their titles, which the app\'s other Escape handlers step aside for', async () => {
  const { container } = await renderEditor();
  await saveIntoExistingName(container);
  assert.equal(screen.queryByRole('dialog', { name: 'File Already Exists' })?.getAttribute('aria-modal') ?? 'missing', 'true');
  press({ key: 'Escape' });

  act(() => {
    fireEvent.click(screen.getByTitle('Generate tasks from PRD content'));
  });
  assert.equal(screen.queryByRole('dialog', { name: 'Generate Tasks from PRD' })?.getAttribute('aria-modal') ?? 'missing', 'true');
});
