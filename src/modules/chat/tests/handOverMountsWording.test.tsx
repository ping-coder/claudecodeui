import assert from 'node:assert/strict';

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import BackgroundSendDialog from '@/modules/chat/composer/BackgroundSendDialog';
import DispatchWaitNotice from '@/modules/chat/composer/DispatchWaitNotice';
import type { DispatchWait } from '@/shared/types';

/**
 * A Claude hand-over the project's mounts block (the server's `directories` label: the mounted
 * folders changed since the held process started) is no change of the message. The background-send
 * dialog and a waiting message's notice say the mounts changed, and never advise changing the
 * message back, which would not help.
 */

const showLanguage = async (language: string) => {
  await act(async () => {
    await i18n.changeLanguage(language);
  });
};

const wait = (changes: string[], heldFor: DispatchWait['heldFor'] = 'loops'): DispatchWait => ({
  target: { kind: 'queued' },
  sessionId: 'session-1',
  provider: 'claude',
  reason: 'held_settings',
  heldFor,
  changes,
  since: '2026-10-30T10:00:00.000Z',
  holdUntil: null,
  actions: ['stop_work_and_send', 'keep_waiting', 'cancel'],
});

const renderWait = (changes: string[], heldFor?: DispatchWait['heldFor']) => render(
  <DispatchWaitNotice
    wait={wait(changes, heldFor)}
    folded={false}
    busy={null}
    notice={null}
    onStopAndSend={() => undefined}
    onUseProcessSettings={() => undefined}
    onKeepWaiting={() => undefined}
    onShowActions={() => undefined}
    onCancel={() => undefined}
  />,
);

const PROMPT = { work: ['Agent Survey the repo'] };

describe('a hand-over the project\'s mounts block', () => {
  afterEach(async () => {
    await showLanguage('en');
  });

  it('the background-send dialog says the mounts changed, without advice to change the message back', () => {
    render(<BackgroundSendDialog prompt={{ ...PROMPT, changes: ['directories'] }} onResolve={() => undefined} />);

    assert.equal(screen.queryAllByText('The project\'s mounted folders changed after this process started, and only a new process can pick them up.').length, 1);
    assert.equal(screen.queryAllByText(/This message changes/).length, 0);
    assert.equal(screen.queryAllByText(/Change (it|them) back/).length, 0);
    // A screen reader hears it with what sending anyway does.
    const describedBy = screen.getByRole('dialog').getAttribute('aria-describedby') ?? '';
    const description = describedBy.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    assert.equal(description.startsWith('The project\'s mounted folders changed'), true);
  });

  it('the dialog names a setting of the message besides, still without the advice', () => {
    render(<BackgroundSendDialog prompt={{ ...PROMPT, changes: ['directories', 'model'] }} onResolve={() => undefined} />);

    assert.equal(screen.queryAllByText(/^The project's mounted folders changed/).length, 1);
    assert.equal(screen.queryAllByText('This message also changes the model, which only a new process can apply.').length, 1);
    assert.equal(screen.queryAllByText(/Change (it|them) back/).length, 0);
  });

  it('the dialog reads in Chinese and Hebrew', async () => {
    await showLanguage('zh-CN');
    const chinese = render(<BackgroundSendDialog prompt={{ ...PROMPT, changes: ['directories'] }} onResolve={() => undefined} />);
    assert.equal(screen.queryAllByText('项目挂载的文件夹在这个进程启动后变了，只有新进程才能用上。').length, 1);
    assert.equal(screen.queryAllByText(/改回原来的设置/).length, 0);
    chinese.unmount();

    await showLanguage('he');
    render(<BackgroundSendDialog prompt={{ ...PROMPT, changes: ['directories'] }} onResolve={() => undefined} />);
    assert.equal(screen.queryAllByText(/^התיקיות המקושרות של הפרויקט השתנו/).length, 1);
  });

  it('a waiting message says the mounts changed in a line of its own, not that the message changes them', () => {
    const loops = renderWait(['directories']);
    assert.equal(screen.queryAllByText('Waiting for the loop to end').length, 1);
    assert.equal(screen.queryAllByText('The project\'s mounted folders changed after the loop\'s process started').length, 1);
    assert.equal(screen.queryAllByText(/this message changes/).length, 0);
    loops.unmount();

    const work = renderWait(['directories', 'model'], 'work');
    assert.equal(screen.queryAllByText('Waiting for the background work to finish: this message changes the model').length, 1);
    assert.equal(screen.queryAllByText('The project\'s mounted folders changed after the background process started').length, 1);
    assert.equal(screen.queryAllByText(/the mounted folders$/).length, 0);
    work.unmount();
  });

  it('a waiting message reads in Chinese', async () => {
    await showLanguage('zh-CN');
    renderWait(['directories']);
    assert.equal(screen.queryAllByText('循环的进程启动后，项目挂载的文件夹变了').length, 1);
    assert.equal(screen.queryAllByText(/这条消息改了/).length, 0);
  });
});
