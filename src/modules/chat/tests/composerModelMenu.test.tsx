import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import type { ProviderModelOption } from '@/shared/types';

/**
 * Ultracode used to be a sixth effort level (xhigh plus workflows). Claude Code
 * now runs it at any effort, so the menu offers it as an on/off switch of its
 * own beside the Reasoning levels, and the trigger says when it is on.
 */

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

const EFFORT_OPTIONS: EffortOption[] = [
  { value: 'low' },
  { value: 'medium' },
  { value: 'high' },
  { value: 'xhigh' },
  { value: 'max' },
];

const MODEL_OPTIONS: ProviderModelOption[] = [
  { value: 'opus', label: 'Opus 5.5', supportsUltracode: true },
  { value: 'haiku', label: 'Haiku 5.5' },
];

type MenuOverrides = Partial<{
  effort: string;
  effortOptions: EffortOption[];
  model: string;
  modelOptions: ProviderModelOption[];
  ultracode: boolean | null;
  onSelectEffort: (effort: string) => void;
  onToggleUltracode: (ultracode: boolean) => void;
}>;

const renderMenu = (overrides: MenuOverrides = {}) =>
  render(
    <ComposerModelMenu
      effort={overrides.effort ?? 'high'}
      effortOptions={overrides.effortOptions ?? EFFORT_OPTIONS}
      onSelectEffort={overrides.onSelectEffort ?? (() => {})}
      model={overrides.model ?? 'opus'}
      modelOptions={overrides.modelOptions ?? MODEL_OPTIONS}
      onSelectModel={() => {}}
      modelsLoading={false}
      ultracode={overrides.ultracode === undefined ? false : overrides.ultracode}
      onToggleUltracode={overrides.onToggleUltracode ?? (() => {})}
    />,
  );

const openMenu = (view: ReturnType<typeof renderMenu>) => {
  fireEvent.click(view.getByRole('button', { name: /^Select model and reasoning effort/ }));
  return view.getByRole('menu');
};

test('a model that cannot run ultracode offers no Ultracode row', () => {
  const view = renderMenu({ model: 'haiku', ultracode: null });
  openMenu(view);

  assert.equal(view.queryByRole('menuitemcheckbox'), null);
  assert.equal(view.queryByText('Ultracode'), null);
});

test('the Ultracode row reports whether it is on', () => {
  const off = renderMenu({ ultracode: false });
  openMenu(off);
  const offRow = off.getByRole('menuitemcheckbox', { name: /Ultracode/ });
  assert.equal(offRow.getAttribute('aria-checked'), 'false');
  assert.match(offRow.textContent ?? '', /Workflow orchestration at any reasoning level/);
  off.unmount();

  const on = renderMenu({ ultracode: true });
  openMenu(on);
  assert.equal(on.getByRole('menuitemcheckbox', { name: /Ultracode/ }).getAttribute('aria-checked'), 'true');
});

test('the Ultracode row sits right after the reasoning levels', () => {
  const view = renderMenu();
  const menu = openMenu(view);

  const roles = Array.from(menu.querySelectorAll('[role^="menuitem"]'), (row) => row.getAttribute('role'));
  // Default plus the five levels, then the switch, then the model row.
  assert.deepEqual(roles, [
    ...Array(EFFORT_OPTIONS.length + 1).fill('menuitemradio'),
    'menuitemcheckbox',
    'menuitem',
  ]);
});

test('toggling ultracode flips it and leaves the menu open for an effort pick', () => {
  for (const ultracode of [false, true]) {
    const onToggleUltracode = vi.fn();
    const view = renderMenu({ ultracode, onToggleUltracode });
    openMenu(view);

    fireEvent.click(view.getByRole('menuitemcheckbox', { name: /Ultracode/ }));

    assert.deepEqual(onToggleUltracode.mock.calls, [[!ultracode]]);
    assert.ok(view.queryByRole('menu'), 'the menu stays open');
    view.unmount();
  }
});

test('picking an effort still closes the menu', () => {
  const onSelectEffort = vi.fn();
  const view = renderMenu({ ultracode: true, onSelectEffort });
  openMenu(view);

  fireEvent.click(view.getByRole('menuitemradio', { name: /^low/i }));

  assert.deepEqual(onSelectEffort.mock.calls, [['low']]);
  assert.equal(view.queryByRole('menu'), null);
});

test('the Ultracode row shows even when the model offers no reasoning levels', () => {
  const view = renderMenu({ effortOptions: [], ultracode: false });
  openMenu(view);

  assert.equal(view.queryAllByRole('menuitemradio').length, 0);
  assert.ok(view.getByRole('menuitemcheckbox', { name: /Ultracode/ }));
});

test('the trigger marks ultracode only while it is on', () => {
  const off = renderMenu({ ultracode: false });
  const offTrigger = off.getByRole('button', { name: /^Select model and reasoning effort/ });
  assert.equal(offTrigger.querySelector('[data-testid="composer-ultracode-indicator"]'), null);
  assert.doesNotMatch(offTrigger.getAttribute('aria-label') ?? '', /Ultracode on/);
  off.unmount();

  const on = renderMenu({ ultracode: true });
  const onTrigger = on.getByRole('button', { name: /^Select model and reasoning effort/ });
  const indicator = onTrigger.querySelector('[data-testid="composer-ultracode-indicator"]');
  assert.ok(indicator, 'the trigger shows the ultracode icon');
  assert.equal(indicator?.getAttribute('aria-hidden'), 'true');
  assert.match(onTrigger.getAttribute('aria-label') ?? '', /Ultracode on/);
  assert.match(onTrigger.getAttribute('title') ?? '', /Ultracode on/);
});

test('nothing renders when there is no effort, model or ultracode to choose', () => {
  const { container } = renderMenu({ effortOptions: [], modelOptions: [], ultracode: null });
  assert.equal(container.innerHTML, '');
});

test('a model missing from the catalog is named by its version, not its raw id', () => {
  const view = renderMenu({ model: 'claude-opus-5-5', ultracode: null });
  const trigger = view.getByRole('button', { name: /^Select model and reasoning effort/ });

  assert.match(trigger.textContent ?? '', /^Opus 5\.5/);
  assert.doesNotMatch(trigger.textContent ?? '', /claude-opus-5-5/);
});

test('a catalog label still wins over the formatted id', () => {
  const view = renderMenu({
    model: 'claude-opus-5-5',
    modelOptions: [{ value: 'claude-opus-5-5', label: 'Opus (pinned)' }],
  });

  assert.match(view.getByRole('button').textContent ?? '', /^Opus \(pinned\)/);
});
