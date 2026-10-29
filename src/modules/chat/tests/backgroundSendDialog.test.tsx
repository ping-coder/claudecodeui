import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { i18n } from '@/modules/i18n';
import BackgroundSendDialog from '@/modules/chat/composer/BackgroundSendDialog';

const PROMPT = { work: ['Workflow frontend-architecture-audit', 'Agent Survey the repo'] };

describe('the background-work send dialog', () => {
  it('lists the work and focuses Cancel on open, so an accidental Enter cancels', async () => {
    render(<BackgroundSendDialog prompt={PROMPT} onResolve={() => {}} />);

    expect(screen.getByText('Workflow frontend-architecture-audit')).toBeTruthy();
    expect(screen.getByText('Agent Survey the repo')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    });
  });

  it('maps each button to its choice', () => {
    const onResolve = vi.fn();
    render(<BackgroundSendDialog prompt={PROMPT} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));

    expect(onResolve.mock.calls).toEqual([['cancel'], ['queue'], ['send']]);
  });

  it('cancels on Escape and on a click outside', () => {
    const onResolve = vi.fn();
    render(<BackgroundSendDialog prompt={PROMPT} onResolve={onResolve} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    const overlay = document.querySelector('[role="dialog"]')?.previousElementSibling;
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay as Element);

    expect(onResolve.mock.calls).toEqual([['cancel'], ['cancel']]);
  });

  it('names what only a new process can apply, for a send that cannot go into the process the work runs in', () => {
    render(<BackgroundSendDialog prompt={{ ...PROMPT, changes: ['model', 'effort', 'permissionMode', 'somethingNew'] }} onResolve={() => {}} />);

    expect(screen.getByText(
      'This message changes the model, the reasoning effort and the permission mode, which only a new process can apply. Change them back to send it without stopping the work.',
    )).toBeTruthy();
    expect(screen.getByText(/^Sending it anyway starts a new process, which stops that work/)).toBeTruthy();
    expect(screen.queryByText(/^A new message starts a new turn/)).toBeNull();
    // A screen reader hears why along with what sending anyway does.
    const describedBy = screen.getByRole('dialog').getAttribute('aria-describedby') ?? '';
    const description = describedBy.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(description.startsWith('This message changes the model')).toBe(true);
    expect(description.includes('Sending it anyway starts a new process')).toBe(true);
  });

  it('says it for one change, or for a send the server could not prepare, and says nothing it does not know', () => {
    const { unmount } = render(<BackgroundSendDialog prompt={{ ...PROMPT, changes: ['model'] }} onResolve={() => {}} />);
    expect(screen.getByText(/^This message changes the model, which only a new process can apply\. Change it back/)).toBeTruthy();
    unmount();

    render(<BackgroundSendDialog prompt={{ ...PROMPT, changes: ['lookup', 'somethingNew'] }} onResolve={() => {}} />);
    expect(screen.getByText('The message could not be handed to the process the work runs in.')).toBeTruthy();
    expect(screen.queryByText(/^This message changes/)).toBeNull();
    expect(screen.getByText(/^Sending it anyway starts a new process/)).toBeTruthy();
  });

  it('keeps the plain wording where every new turn stops the work', () => {
    render(<BackgroundSendDialog prompt={PROMPT} onResolve={() => {}} />);

    expect(screen.getByText(/^A new message starts a new turn, which stops that work/)).toBeTruthy();
    expect(screen.queryByText(/^This message changes/)).toBeNull();
  });

  it('offers no Queue for scheduled work alone, and says the loops stop', () => {
    const onResolve = vi.fn();
    render(<BackgroundSendDialog prompt={{ work: ['Loop check CI'], changes: ['effort'], queue: false }} onResolve={onResolve} />);

    expect(screen.queryAllByText('Loop check CI').length).toBe(1);
    expect(screen.queryAllByRole('button', { name: 'Queue' }).length).toBe(0);
    expect(screen.queryAllByText('This message has to run in a new process, which stops these loops.').length).toBe(1);
    expect(screen.queryAllByText(/Queue the message/).length).toBe(0);
    // Why the message needs a new process is still said.
    expect(screen.queryAllByText(/^This message changes the reasoning effort/).length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onResolve.mock.calls).toEqual([['send'], ['cancel']]);
  });

  it('has its new strings in English and Simplified Chinese', () => {
    const keys = [
      'claudeStatus.backgroundTask.prompt.descriptionNewProcess',
      'claudeStatus.backgroundTask.prompt.changes_one',
      'claudeStatus.backgroundTask.prompt.changes_other',
      'claudeStatus.backgroundTask.prompt.changeSeparator',
      'claudeStatus.backgroundTask.prompt.changeLastSeparator',
      'claudeStatus.backgroundTask.prompt.change.model',
      'claudeStatus.backgroundTask.prompt.change.effort',
      'claudeStatus.backgroundTask.prompt.change.ultracode',
      'claudeStatus.backgroundTask.prompt.change.permissionMode',
      'claudeStatus.backgroundTask.prompt.change.tools',
      'claudeStatus.backgroundTask.prompt.change.cwd',
      'claudeStatus.backgroundTask.prompt.lookupFailed',
    ];
    // Read from each language's own strings: a lookup would fall back to English.
    const missing = ['en', 'zh-CN'].flatMap((language) => keys
      .filter((key) => language !== 'zh-CN' || key !== 'claudeStatus.backgroundTask.prompt.changes_one')
      .filter((key) => typeof i18n.getResource(language, 'chat', key) !== 'string')
      .map((key) => `${language} ${key}`));
    expect(missing).toEqual([]);
  });

  it('renders nothing while no prompt is open', () => {
    render(<BackgroundSendDialog prompt={null} onResolve={() => {}} />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
