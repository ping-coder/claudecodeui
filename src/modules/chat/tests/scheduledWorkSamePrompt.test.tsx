import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { i18n } from '@/modules/i18n';
import { ScheduledWorkChips } from '@/modules/chat/transcript/ScheduledWorkChips';
import type { ScheduledWorkSummary } from '@/shared/types';

/**
 * A model sometimes writes /loop into the loop's own prompt, so every run adds another loop with
 * the same prompt. Stopping one of them from its ✕ then says how many others in the session have
 * that prompt, and puts "Stop all" first, as the main action.
 */

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => {} }),
}));

vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useSessionProtectionActions: () => ({ refreshRunningSessions: async () => {}, markSessionProcessing: () => {} }),
}));

const NOW = new Date(2026, 9, 29, 10, 0).getTime();

const loop = (id: string, prompt: string, overrides: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
  id,
  kind: 'cron',
  toolUseId: `toolu_${id}`,
  prompt,
  startedAt: NOW - 60_000,
  nextFireAt: NOW + 300_000,
  recurring: true,
  holdUntil: NOW + 8 * 86_400_000,
  cron: '*/5 * * * *',
  cadence: 'Every 5 minutes',
  ...overrides,
});

const renderChips = (items: ScheduledWorkSummary[]) => {
  const sendMessage = vi.fn();
  render(
    <ScheduledWorkChips
      items={items}
      hasTasks={false}
      messages={[]}
      sessionId="session-1"
      canStop
      isTurnRunning={false}
      sendMessage={sendMessage}
      onReveal={() => {}}
      onLoadAll={() => {}}
    />,
  );
  return { sendMessage };
};

const stopButtons = () => screen.queryAllByRole('button', { name: i18n.t('chat:scheduledWork.stop') });
const question = () => screen.getByRole('group');
/** The question's buttons, in the order they are drawn. */
const actionNames = () => within(question()).getAllByRole('button').map((button) => button.textContent ?? '');
const isSolid = (name: RegExp) => within(question()).getByRole('button', { name }).className.split(' ').includes('bg-destructive');

const SAME = '/loop 5m check CI';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage('en');
});

describe('stopping one of several loops with the same prompt', () => {
  it('says how many others have the prompt and puts Stop all first, as the main action', () => {
    const { sendMessage } = renderChips([
      loop('cron:00000001', SAME),
      loop('cron:00000002', SAME),
      loop('cron:00000003', `  ${SAME}\n`),
      loop('cron:00000004', 'watch the deploy'),
    ]);
    fireEvent.click(stopButtons()[0]);

    expect(question().textContent?.includes('2 other loops in this session have the same prompt.')).toBe(true);
    expect(actionNames()).toEqual(['Stop all (4)', 'Stop', 'Cancel']);
    expect(isSolid(/^Stop all/)).toBe(true);
    expect(isSolid(/^Stop$/)).toBe(false);
    // Cancel still takes the focus, so an Enter pressed by mistake stops nothing.
    expect(document.activeElement?.textContent).toBe('Cancel');

    fireEvent.click(within(question()).getByRole('button', { name: /^Stop all/ }));
    const frame = sendMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(frame.allScheduled).toBe(true);
  });

  it('counts one other loop in the singular', () => {
    renderChips([loop('cron:00000001', SAME), loop('cron:00000002', SAME)]);
    fireEvent.click(stopButtons()[1]);
    expect(question().textContent?.includes('Another loop in this session has the same prompt.')).toBe(true);
  });

  it('asks as before when no other loop has the prompt', () => {
    renderChips([loop('cron:00000001', SAME), loop('cron:00000004', 'watch the deploy')]);
    fireEvent.click(stopButtons()[0]);
    expect(question().textContent?.includes('same prompt')).toBe(false);
    expect(actionNames()).toEqual(['Stop', 'Cancel', 'Stop all (2)']);
    expect(isSolid(/^Stop$/)).toBe(true);
    expect(isSolid(/^Stop all/)).toBe(false);
  });

  it('does not count a reminder with the prompt as another loop', () => {
    renderChips([loop('cron:00000001', SAME), loop('cron:00000002', SAME, { recurring: false })]);
    fireEvent.click(stopButtons()[0]);
    expect(question().textContent?.includes('same prompt')).toBe(false);
  });

  const threeAlike = () => [loop('cron:00000001', SAME), loop('cron:00000002', SAME), loop('cron:00000003', SAME)];

  it('says it in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    renderChips(threeAlike());
    fireEvent.click(stopButtons()[0]);
    expect(question().textContent?.includes('这个会话里还有 2 个提示词一样的循环。')).toBe(true);
    expect(actionNames()).toEqual(['全部停掉（3）', '停掉', '取消']);
  });

  it('says it in Hebrew, with its dual', async () => {
    await i18n.changeLanguage('he');
    renderChips(threeAlike());
    fireEvent.click(stopButtons()[0]);
    expect(question().textContent?.includes('בסשן הזה יש עוד שתי לולאות עם אותו פרומפט.')).toBe(true);
  });
});

describe('a loop whose prompt starts with /loop', () => {
  // What a loop the model wrote /loop into runs each time it fires: another loop with the rest.
  const TICK = 'Reply with exactly the word TICK and nothing else. Use no tools.';

  it('counts the loop it makes as one with the same prompt', () => {
    renderChips([loop('cron:00000001', `/loop 1m ${TICK}`), loop('cron:00000002', TICK)]);
    fireEvent.click(stopButtons()[0]);
    expect(question().textContent?.includes('Another loop in this session has the same prompt.')).toBe(true);
  });

  it('counts it from either side, a self-paced /loop and an interval too', () => {
    renderChips([
      loop('cron:00000001', TICK),
      loop('cron:00000002', `/loop 5m   ${TICK}`),
      loop('wakeup:chain-1', `/loop ${TICK}`, { kind: 'wakeup' }),
    ]);
    fireEvent.click(stopButtons()[0]);
    expect(question().textContent?.includes('2 other loops in this session have the same prompt.')).toBe(true);
  });

  it('matches the start a long prompt was cut to', () => {
    // The server lists a prompt's first 200 characters, so "/loop 1m " leaves the first loop 9 fewer.
    const long = `${'Check the deploy and report each failing step with its log. '.repeat(4)}Then stop.`;
    const listed = (prompt: string) => Array.from(prompt).slice(0, 200).join('');
    renderChips([loop('cron:00000001', listed(`/loop 1m ${long}`)), loop('cron:00000002', listed(long))]);
    fireEvent.click(stopButtons()[0]);
    expect(question().textContent?.includes('Another loop in this session has the same prompt.')).toBe(true);
  });

  const unlike = () => [
    loop('cron:00000001', `/loop 1m ${TICK}`),
    loop('cron:00000002', '/loop 1m Reply with the word TOCK.'),
    loop('cron:00000003', 'Reply with exactly the word TICK'),
  ];

  it('does not count a different prompt after /loop, or one that only starts the same', () => {
    renderChips(unlike());
    fireEvent.click(stopButtons()[0]);
    expect(question().textContent?.includes('same prompt')).toBe(false);
  });

  it('does not count a longer prompt as the same as a shorter one that was not cut', () => {
    renderChips(unlike());
    fireEvent.click(stopButtons()[2]);
    expect(question().textContent?.includes('same prompt')).toBe(false);
  });
});
