import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import { BashCommandDisplay } from '@/modules/chat/tools/BashCommandDisplay';

/**
 * A command over several lines reads as code once its card is expanded: left to right, so a
 * right-to-left UI does not end each line at the right and hide the indentation. A one-line
 * command keeps the row's direction, next to the "$".
 */

const commandSpan = (start: string) => screen.getByText((_, element) => element?.tagName === 'SPAN' && (element.textContent ?? '').startsWith(start) && element.classList.contains('font-mono'));

test('an expanded command over several lines is left to right; collapsed, or on one line, it is not', () => {
  const view = render(<BashCommandDisplay command={"python3 - <<'PY'\nfor k in x:\n    print(k)\nPY"} output="a\nb" />);
  assert.equal(commandSpan('python3').hasAttribute('dir'), false, 'collapsed: one truncated line');
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  assert.equal(commandSpan('python3').getAttribute('dir'), 'ltr');
  // Right to left the block keeps to the "$" side, the room left going past it.
  assert.deepEqual(['rtl:ml-auto', 'rtl:flex-initial'].map((name) => commandSpan('python3').classList.contains(name)), [true, true]);
  view.unmount();

  render(<BashCommandDisplay command="ls -la" output="a" />);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  assert.equal(commandSpan('ls -la').hasAttribute('dir'), false);
  assert.equal(commandSpan('ls -la').classList.contains('rtl:flex-initial'), false);
});
