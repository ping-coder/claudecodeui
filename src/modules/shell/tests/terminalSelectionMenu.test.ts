import assert from 'node:assert/strict';

import { act, fireEvent, renderHook } from '@testing-library/react';
import React from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { useShellTerminal } from '@/modules/shell/hooks/useShellTerminal';
import type * as MobileTerminalSelection from '@/modules/shell/utils/mobileTerminalSelection';
import type { MobileTerminalSelectionLabels } from '@/modules/shell/utils/mobileTerminalSelection';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import type { Project } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * The touch-selection menu over the Shell terminal says "Copy" and "Select All" in the UI
 * language. It reads its labels each time it opens, so a language switch reaches a terminal that
 * is already open, without rebuilding it (which would close the socket).
 */

const { terminals, installs } = vi.hoisted(() => ({
  terminals: [] as Array<{ disposed: boolean }>,
  installs: [] as Array<{ getLabels: () => MobileTerminalSelectionLabels }>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    disposed = false;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terminals.push(this);
    }

    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    getSelection() {
      return '';
    }
    hasSelection() {
      return false;
    }
    clear() {}
    write() {}
    refresh() {}
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
vi.mock('@/modules/shell/utils/mobileTerminalSelection', () => ({
  installMobileTerminalSelection: (_terminal: unknown, _content: unknown, options: { getLabels: () => MobileTerminalSelectionLabels }) => {
    installs.push(options);
    return { dispose() {}, updateHandles() {} };
  },
}));
vi.mock('@/modules/shell/utils/socket', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShellWebSocketUrl: () => 'ws://localhost/shell',
}));

const { installMobileTerminalSelection } = await vi.importActual<typeof MobileTerminalSelection>(
  '@/modules/shell/utils/mobileTerminalSelection',
);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class FakeSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {
    this.readyState = 3;
  }
}

const project = { projectId: 'demo', name: 'demo', displayName: 'demo', path: '/tmp/demo', fullPath: '/tmp/demo' } as Project;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('WebSocket', FakeSocket);
  localStorage.clear();
  resetUserPreferences();
  document.body.innerHTML = '';
  terminals.length = 0;
  installs.length = 0;
});

afterEach(async () => {
  await i18n.changeLanguage('en');
  vi.unstubAllGlobals();
});

function renderShellTerminal() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  // Stable, like the shell's own: a new function each render would rebuild the terminal.
  const closeSocket = () => {};
  return renderHook(
    () => {
      useShellTerminal({
        terminalContainerRef: React.useRef<HTMLDivElement>(container),
        terminalRef: React.useRef<Terminal | null>(null),
        fitAddonRef: React.useRef<FitAddon | null>(null),
        wsRef: React.useRef<WebSocket | null>(null),
        selectedProject: project,
        minimal: false,
        isRestarting: false,
        closeSocket,
      });
    },
    { wrapper: ({ children }: { children: React.ReactNode }) => React.createElement(ThemeProvider, null, children) },
  );
}

test('the shell hands the menu its labels from the chat locale and a language switch reaches the open terminal', async () => {
  renderShellTerminal();
  assert.equal(installs.length === 1, true);
  const labels = () => installs[0].getLabels();
  assert.equal(labels().copy, 'Copy');
  assert.equal(labels().selectAll, 'Select All');

  await act(async () => {
    await i18n.changeLanguage('he');
  });

  const hebrew = i18n.getFixedT('he', 'chat');
  assert.equal(labels().copy, hebrew('shell.selectionMenu.copy'));
  assert.equal(labels().selectAll, hebrew('shell.selectionMenu.selectAll'));
  // A Hebrew word, or the English one set apart as a fallback: either way it went through the Hebrew locale.
  assert.equal(labels().copy !== 'Copy', true);
  assert.equal(terminals.length === 1 && !terminals[0].disposed, true);
});

/** Just enough of an xterm Terminal for the selection layer: a whole-buffer selection. */
function fakeTerminal(container: HTMLElement): Terminal {
  const element = document.createElement('div');
  container.appendChild(element);
  let selected = false;
  const disposable = () => ({ dispose() {} });
  return {
    element,
    cols: 80,
    rows: 24,
    options: { fontSize: 14 },
    onSelectionChange: disposable,
    onResize: disposable,
    onScroll: disposable,
    select() {},
    selectAll() {
      selected = true;
    },
    hasSelection: () => selected,
    getSelection: () => (selected ? 'everything' : ''),
    clearSelection() {
      selected = false;
    },
    refresh() {},
  } as unknown as Terminal;
}

test('the menu shows the labels it is given and reads them again when it opens', () => {
  // A touch screen: the layer installs nothing without one.
  vi.stubGlobal('ontouchstart', null);
  const container = document.createElement('div');
  document.body.appendChild(container);
  let labels: MobileTerminalSelectionLabels = { copy: 'Copy', selectAll: 'Select All' };

  const manager = installMobileTerminalSelection(fakeTerminal(container), container, { getLabels: () => labels });
  assert.equal(manager !== null, true);
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.shell-mobile-selection-menu button')];
  assert.equal(buttons().map((button) => button.textContent).join(' | '), 'Copy | Select All');

  labels = { copy: '复制', selectAll: '全选' };
  // "Select All" selects the whole buffer and opens the menu again.
  fireEvent.mouseDown(buttons()[1]);
  fireEvent.mouseUp(buttons()[1]);
  assert.equal(buttons().map((button) => button.textContent).join(' | '), '复制 | 全选');
  assert.equal((container.querySelector('.shell-mobile-selection-menu') as HTMLElement).style.display, 'flex');

  manager?.dispose();
});
