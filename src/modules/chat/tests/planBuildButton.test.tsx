import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import type { PermissionContextValue } from '@/modules/chat/context/PermissionContext';
import { PlanDisplay } from '@/modules/chat/tools/PlanDisplay';
import type { PendingPermissionRequest } from '@/shared/types';

/**
 * The Build button of a plan waiting for approval carried a "⌘↩" badge, on every platform, for a
 * shortcut that does not exist: no key builds the plan (Ctrl/Cmd+Enter in the composer sends a
 * message). The badge is gone; the button still builds the plan.
 */

const renderPendingPlan = () => {
  const handlePermissionDecision = vi.fn<PermissionContextValue['handlePermissionDecision']>();
  const request = { requestId: 'plan-1', toolName: 'ExitPlanMode', input: { plan: '# Plan' } } as PendingPermissionRequest;
  render(
    <PermissionContext.Provider value={{ pendingPermissionRequests: [request], handlePermissionDecision }}>
      <PlanDisplay title="Implementation plan" content="# Plan" defaultOpen toolName="ExitPlanMode" />
    </PermissionContext.Provider>,
  );
  return handlePermissionDecision;
};

test('Build shows no shortcut badge', () => {
  renderPendingPlan();
  const build = screen.getByRole('button', { name: 'Build' });
  assert.equal(build.textContent, 'Build');
  assert.equal(build.querySelector('kbd') === null, true);
});

test('no key builds the plan, which is why no badge promises one; a click does', () => {
  const decide = renderPendingPlan();
  const build = screen.getByRole('button', { name: 'Build' });
  for (const target of [document.body, build]) {
    fireEvent.keyDown(target, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(target, { key: 'Enter', ctrlKey: true });
  }
  assert.equal(decide.mock.calls.length, 0);

  fireEvent.click(build);
  assert.equal(decide.mock.calls.length, 1);
  const [requestId, decision] = decide.mock.calls[0] ?? [];
  assert.equal(requestId, 'plan-1');
  assert.equal(decision?.allow, true);
});
