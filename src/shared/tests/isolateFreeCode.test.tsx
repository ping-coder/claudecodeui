import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { Trans } from 'react-i18next';
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import AgentConnectionsStep from '@/modules/onboarding/AgentConnectionsStep';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import { IsolateFreeCode } from '@/shared/ui/IsolateFreeCode';
import type { ProviderAuthStatus } from '@/shared/types';

/**
 * Right to left, a value inside a Trans `<code>` is drawn without the isolates the interface wraps
 * values in: the code element already reads left to right, and a selection of it (Linux pastes the
 * selection on a middle click, with no copy event to clean it up) must carry the command as typed.
 * The isolates around values outside the code stay.
 */

const ISOLATES = /[\u2066-\u2069]/;
const hasIsolates = (text: string | null | undefined) => ISOLATES.test(text ?? '');
const codeTexts = (root: ParentNode = document.body) => [...root.querySelectorAll('code')].map((code) => code.textContent ?? '');

const signedOut = (overrides: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus => ({
  authenticated: false,
  email: null,
  method: null,
  error: 'Run `agy` once in a terminal to sign in',
  loading: false,
  installed: true,
  ...overrides,
});

const NS = 'isolateFreeCodeTest';

beforeAll(() => {
  i18n.addResourceBundle('he', NS, { run: 'יש להריץ את <code>{{command}}</code> ב-{{place}}' });
});

afterAll(() => {
  i18n.removeResourceBundle('he', NS);
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('IsolateFreeCode', () => {
  it('draws the value without isolates, and leaves the rest of the sentence alone', async () => {
    await i18n.changeLanguage('he');
    render(
      <p data-testid="line">
        <Trans ns={NS} i18nKey="run" values={{ command: 'claude login', place: '/tmp' }} components={{ code: <IsolateFreeCode className="x" /> }} />
      </p>,
    );
    assert.deepEqual(codeTexts(), ['claude login']);
    assert.equal(document.querySelector('code')?.className, 'x');
    // The other value is still isolated.
    assert.equal(screen.getByTestId('line').textContent?.includes('\u2068/tmp\u2069'), true);
  });

  it('leaves an element child as it is', () => {
    render(<IsolateFreeCode><b>bold</b> text</IsolateFreeCode>);
    assert.equal(document.querySelector('code b')?.textContent, 'bold');
    assert.equal(document.querySelector('code')?.textContent, 'bold text');
  });
});

describe('the sign-in hints and the command help, in Hebrew', () => {
  it('onboarding: the command reads as typed', async () => {
    await i18n.changeLanguage('he');
    render(
      <AgentConnectionsStep
        providerStatuses={{ claude: signedOut(), cursor: signedOut(), codex: signedOut(), opencode: signedOut(), agy: signedOut() }}
        onOpenProviderLogin={() => {}}
      />,
    );
    const hint = screen.getByTestId('terminal-sign-in-hint');
    assert.deepEqual(codeTexts(hint), ['agy']);
  });

  it('onboarding, not installed: the command reads as typed, the agent stays isolated', async () => {
    await i18n.changeLanguage('he');
    render(
      <AgentConnectionsStep
        providerStatuses={{ claude: signedOut(), cursor: signedOut(), codex: signedOut(), opencode: signedOut(), agy: signedOut({ installed: false }) }}
        onOpenProviderLogin={() => {}}
      />,
    );
    const hint = screen.getByTestId('terminal-sign-in-hint');
    assert.deepEqual(codeTexts(hint), ['agy']);
    assert.equal(hasIsolates(hint.textContent), true);
  });

  it('settings: the command reads as typed', async () => {
    await i18n.changeLanguage('he');
    render(<AccountContent agent="agy" authStatus={signedOut()} />);
    assert.deepEqual(codeTexts(screen.getByTestId('provider-terminal-sign-in')), ['agy']);
  });

  it('/help: the tokens read as typed', async () => {
    await i18n.changeLanguage('he');
    render(
      <CommandResultModal
        payload={{ kind: 'help', data: { commands: [] } }}
        onClose={() => {}}
        providerModelCatalog={{}}
        providerModelActions={{ create: async () => {}, update: async () => {}, remove: async () => {}, setCustomModelsOnly: async () => {} }}
        activeProvider="claude"
        activeProviderModel="default"
        currentSessionId={null}
        onSelectProviderModel={async () => ({ scope: 'default', model: 'default' })}
      />,
    );
    const texts = codeTexts();
    for (const token of ['$ARGUMENTS', '$1', '$2', '@file', '/']) {
      assert.equal(texts.includes(token), true, token);
    }
    assert.equal(texts.some(hasIsolates), false);
  });
});
