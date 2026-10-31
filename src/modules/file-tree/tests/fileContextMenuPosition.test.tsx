import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import FileContextMenu from '@/modules/file-tree/FileContextMenu';

/**
 * Where a file row's right-click menu opens: from the pointer towards the end of the line, so its
 * left edge is at the pointer left to right and its right edge right to left, however wide its
 * labels make it, and inside the viewport near either edge. Opened from a button, such as the ⋯ on
 * the project root's row, it hangs below the button from its start edge the same way.
 */

const FILE = { name: 'a.ts', type: 'file' as const, path: '/repo/a.ts' };

// What <html dir="rtl"> computes in a browser; jsdom neither maps dir to direction nor inherits it.
const inRightToLeft = (run: () => void) => {
  const style = document.createElement('style');
  style.textContent = '[dir="rtl"], [dir="rtl"] * { direction: rtl; }';
  document.head.append(style);
  document.documentElement.setAttribute('dir', 'rtl');
  try {
    run();
  } finally {
    document.documentElement.removeAttribute('dir');
    style.remove();
  }
};

const openMenuAt = (clientX: number) => {
  const view = render(
    <FileContextMenu item={FILE} onRename={() => undefined}>
      <div data-testid="row">a.ts</div>
    </FileContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('row'), { clientX, clientY: 100 });
  const menu = screen.getByRole('menu');
  return { left: menu.style.left, right: menu.style.right, unmount: view.unmount };
};

test('left to right the menu opens rightwards from the pointer', () => {
  const { left, right } = openMenuAt(300);
  assert.equal(left, '300px');
  assert.equal(right, '');
});

test('right to left the menu opens leftwards, its right edge at the pointer, and stays inside the viewport', () => {
  inRightToLeft(() => {
    const atPointer = openMenuAt(600);
    assert.equal(atPointer.right, `${window.innerWidth - 600}px`);
    assert.equal(atPointer.left, '');
    atPointer.unmount();

    // Too close to the left edge for the menu: it starts at the edge's padding instead.
    const nearEdge = openMenuAt(120);
    assert.equal(nearEdge.left, '10px');
    assert.equal(nearEdge.right, '');
  });
});

/** Opens the root menu from a button whose box is at x 300–320, y 80–100. */
const openMenuFromButton = () => {
  const view = render(
    <FileContextMenu onRefresh={() => undefined}>
      {(trigger) => <button type="button" {...trigger}>more</button>}
    </FileContextMenu>,
  );
  const button = screen.getByRole('button', { name: 'more' });
  button.getBoundingClientRect = () => ({ x: 300, y: 80, left: 300, top: 80, right: 320, bottom: 100, width: 20, height: 20, toJSON: () => ({}) }) as DOMRect;
  fireEvent.click(button, { detail: 1 });
  const menu = screen.getByRole('menu');
  return { left: menu.style.left, right: menu.style.right, top: menu.style.top, unmount: view.unmount };
};

test('opened from a button the menu hangs below it, from its left edge left to right and its right edge right to left', () => {
  const leftToRight = openMenuFromButton();
  assert.deepEqual([leftToRight.left, leftToRight.right, leftToRight.top], ['300px', '', '100px']);
  leftToRight.unmount();

  inRightToLeft(() => {
    const rightToLeft = openMenuFromButton();
    assert.deepEqual([rightToLeft.left, rightToLeft.right, rightToLeft.top], ['', `${window.innerWidth - 320}px`, '100px']);
  });
});
