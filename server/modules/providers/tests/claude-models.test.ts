import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  ClaudeProviderModels,
  extractClaudeEventModel,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a newer placeholder or modelless content part so an earlier real model still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model>claude-sonnet-5</model>' },
            { text: '<model><synthetic></model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<local-command-stdout>Set model to `opus`</local-command-stdout>' },
            { text: 'next prompt' },
          ],
        },
      },
      SESSION_ID,
    ),
    'opus',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

/** Runs one `/model` stdout block (as Claude Code writes it into a transcript row) through the event parser. */
const modelFromStdout = (stdout: string, trailing = ''): string | null => extractClaudeEventModel(
  {
    sessionId: SESSION_ID,
    message: { content: `<local-command-stdout>${stdout}</local-command-stdout>${trailing}` },
  },
  SESSION_ID,
);

test('reads backtick-quoted ids from /model stdout verbatim', () => {
  assert.equal(modelFromStdout('Set model to `claude-opus-5-5`'), 'claude-opus-5-5');
  assert.equal(modelFromStdout('Set model to `claude-sonnet-5-5[1m]`'), 'claude-sonnet-5-5[1m]');
  assert.equal(modelFromStdout('Set model to `claude-haiku-4-5@20251001`'), 'claude-haiku-4-5@20251001');
  assert.equal(modelFromStdout('Set model to `opus`'), 'opus');
});

test('maps /model display names to the canonical ids --model accepts', () => {
  assert.equal(modelFromStdout('Set model to `Opus 5.5`'), 'claude-opus-5-5');
  assert.equal(modelFromStdout('Set model to `Fable 5.1`'), 'claude-fable-5-1');
  assert.equal(modelFromStdout('Set model to `Sonnet 5`'), 'claude-sonnet-5');
  assert.equal(modelFromStdout('Set model to `Haiku 4.5`'), 'claude-haiku-4-5');
  assert.equal(modelFromStdout('Set model to `Opus 5.5 (1M context)`'), 'claude-opus-5-5[1m]');
  assert.equal(modelFromStdout('Kept model as `Opus 5.5`'), 'claude-opus-5-5');
});

test('never includes the trailing clauses /model appends', () => {
  assert.equal(
    modelFromStdout('Set model to `Opus 5.5` and saved as your default for new sessions'),
    'claude-opus-5-5',
  );
  assert.equal(
    modelFromStdout('Set model to `Opus 5.5` and saved as your default for new sessions · `max` effort for this session only'),
    'claude-opus-5-5',
  );
  assert.equal(modelFromStdout('Set model to `claude-opus-5-5` for this session only'), 'claude-opus-5-5');
  assert.equal(modelFromStdout('Set model to `Sonnet 5` for this session only · `low` effort'), 'claude-sonnet-5');
});

test('reads unquoted and ANSI-bolded /model stdout', () => {
  assert.equal(modelFromStdout('Set model to opus'), 'opus');
  assert.equal(modelFromStdout('Set model to opus.'), 'opus');
  assert.equal(modelFromStdout('Set model to opus for this session only'), 'opus');
  assert.equal(modelFromStdout('Set model to Opus 5.5 and saved as your default for new sessions'), 'claude-opus-5-5');
  assert.equal(modelFromStdout('Set model to \u001b[1mHaiku 4.5\u001b[22m'), 'claude-haiku-4-5');
  assert.equal(modelFromStdout('Set model to sonnet (claude-sonnet-4-20250514)'), 'claude-sonnet-4-20250514');
});

test('maps the Default and opusplan choices, which /model names without an id, to their aliases', () => {
  // Claude Code prints Default as the model it resolves to plus " (default)",
  // and opusplan as a sentence.
  assert.equal(modelFromStdout('Set model to `Opus 5.5 (default)` for this session only'), 'default');
  assert.equal(
    modelFromStdout('Set model to `Opus 5.5 (default)` and saved as your default for new sessions'),
    'default',
  );
  assert.equal(modelFromStdout('Set model to `Opus in plan mode, else Sonnet` for this session only'), 'opusplan');
  assert.equal(modelFromStdout('Kept model as `Opus Plan`'), 'opusplan');
});

test('a /model switch to a name it cannot map answers "default" unless a <model> tag names the model', () => {
  // "default" is the provider's "no answer"; it stops the transcript scan so
  // an older row cannot report the model from before the switch.
  assert.equal(modelFromStdout('Set model to `Some Future Model`'), 'default');
  assert.equal(
    modelFromStdout('Set model to `Some Future Model`', '<model>claude-sonnet-5</model>'),
    'claude-sonnet-5',
  );
  // A display name of a model family that is not Claude's is not guessed at.
  assert.equal(modelFromStdout('Set model to `GLM 4.6`'), 'default');
  // Text without a model statement says nothing about the model.
  assert.equal(modelFromStdout('Current model: Opus 5.5'), null);
});

test('a quoted placeholder in /model stdout is rejected', () => {
  assert.equal(modelFromStdout('Set model to `<synthetic>`'), null);
  assert.equal(
    modelFromStdout('Set model to `<synthetic>`', '<model>claude-sonnet-5</model>'),
    'claude-sonnet-5',
  );
});

/**
 * Writes `rows` as a session transcript, registers the session with that
 * jsonl path in an isolated database, and returns the model the Claude
 * models provider reads back for it.
 */
async function readActiveModelFromTranscript(rows: unknown[]): Promise<string> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-active-model-'));
  const jsonlPath = path.join(tempDirectory, `${SESSION_ID}.jsonl`);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await writeFile(jsonlPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const sessionId = sessionsDb.createSession(
      SESSION_ID,
      'claude',
      '/workspace/demo',
      'Demo',
      undefined,
      undefined,
      jsonlPath,
    );
    return (await new ClaudeProviderModels().getCurrentActiveModel(sessionId)).model;
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const transcriptAssistantRow = (model: string) => ({
  type: 'assistant',
  sessionId: SESSION_ID,
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
});

const transcriptStdoutRow = (stdout: string) => ({
  type: 'user',
  sessionId: SESSION_ID,
  message: { role: 'user', content: `<local-command-stdout>${stdout}</local-command-stdout>` },
});

test('an assistant row answers with its own model even when its text quotes /model output', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        type: 'assistant',
        sessionId: SESSION_ID,
        message: {
          model: 'claude-opus-5-5',
          content: [{ text: 'The CLI wrote <local-command-stdout>Set model to `Haiku 5.5`</local-command-stdout>.' }],
        },
      },
      SESSION_ID,
    ),
    'claude-opus-5-5',
  );
});

test('the newest command output in a multi-part message wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        type: 'user',
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<local-command-stdout>Set model to `Opus 5.5 (default)` for this session only</local-command-stdout>' },
            { text: '<local-command-stdout>Set model to `Haiku 5.5`</local-command-stdout>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-haiku-5-5',
  );
});

test('an assistant row reports the model it was requested as, keeping [1m] and the provider spelling', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        type: 'assistant',
        sessionId: SESSION_ID,
        requestedModel: 'claude-opus-5-5[1m]',
        message: { model: 'claude-opus-5-5', content: [{ text: 'ok' }] },
      },
      SESSION_ID,
    ),
    'claude-opus-5-5[1m]',
  );
  assert.equal(
    extractClaudeEventModel(
      {
        type: 'assistant',
        sessionId: SESSION_ID,
        requestedModel: 'claude-haiku-4-5@20251001',
        message: { model: 'claude-haiku-4-5-20251001', content: [{ text: 'ok' }] },
      },
      SESSION_ID,
    ),
    'claude-haiku-4-5@20251001',
  );
  // Rows written before the field existed fall back to message.model.
  assert.equal(
    extractClaudeEventModel(
      { type: 'assistant', sessionId: SESSION_ID, message: { model: 'claude-opus-5-5', content: [] } },
      SESSION_ID,
    ),
    'claude-opus-5-5',
  );
});

test('api-request-blob rows, which replay every output since the last reply, are skipped', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        type: 'api-request-blob',
        sessionId: SESSION_ID,
        message: { content: [{ text: '<local-command-stdout>Set model to `Opus 5.5`</local-command-stdout>' }] },
      },
      SESSION_ID,
    ),
    null,
  );
});

test('the transcript scan reports a later /model switch, not the model from before it', async () => {
  assert.equal(
    await readActiveModelFromTranscript([
      transcriptAssistantRow('claude-sonnet-5-5'),
      transcriptStdoutRow('Set model to `Opus 5.5` and saved as your default for new sessions'),
    ]),
    'claude-opus-5-5',
  );
  assert.equal(
    await readActiveModelFromTranscript([
      transcriptAssistantRow('claude-sonnet-5-5'),
      transcriptStdoutRow('Set model to `Opus in plan mode, else Sonnet` for this session only'),
    ]),
    'opusplan',
  );
  // Default, or a model the parser cannot name, must not revive the older
  // Sonnet row: the answer is the provider's "no answer" default.
  assert.equal(
    await readActiveModelFromTranscript([
      transcriptAssistantRow('claude-sonnet-5-5'),
      transcriptStdoutRow('Set model to `Opus 5.5 (default)` for this session only'),
    ]),
    'default',
  );
  assert.equal(
    await readActiveModelFromTranscript([
      transcriptAssistantRow('claude-sonnet-5-5'),
      transcriptStdoutRow('Set model to `Some Future Model`'),
    ]),
    'default',
  );
  // A request copy bundling an older Default switch with the newer Haiku one
  // must not hide the Haiku switch written as its own row.
  assert.equal(
    await readActiveModelFromTranscript([
      transcriptAssistantRow('claude-sonnet-5-5'),
      transcriptStdoutRow('Set model to `Opus 5.5 (default)` for this session only'),
      transcriptStdoutRow('Set model to `Haiku 5.5` for this session only'),
      {
        type: 'api-request-blob',
        sessionId: SESSION_ID,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<local-command-stdout>Set model to `Opus 5.5 (default)` for this session only</local-command-stdout>' },
            { type: 'text', text: '<local-command-stdout>Set model to `Haiku 5.5` for this session only</local-command-stdout>' },
            { type: 'text', text: 'next prompt' },
          ],
        },
      },
    ]),
    'claude-haiku-5-5',
  );
  // A reply after the switch is the newest evidence and wins.
  assert.equal(
    await readActiveModelFromTranscript([
      transcriptStdoutRow('Set model to `Opus 5.5 (default)` for this session only'),
      transcriptAssistantRow('claude-opus-5-5'),
    ]),
    'claude-opus-5-5',
  );
});

/** The picker label of one built-in Claude option. */
const catalogLabel = (value: string): string => {
  const option = CLAUDE_PREDEFINED_MODELS.OPTIONS.find((candidate) => candidate.value === value);
  assert.ok(option, `catalog has no ${value} option`);
  return option.label;
};

const CLAUDE_FAMILY_ALIASES = { fable: 'Fable', sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' } as const;

test('every Claude family alias is labelled with the version of the model it resolves to', () => {
  // Exact numbers are not pinned: they follow the Claude Code release.
  for (const [alias, family] of Object.entries(CLAUDE_FAMILY_ALIASES)) {
    assert.match(catalogLabel(alias), new RegExp(`^${family} \\d+(?:\\.\\d+)?$`), `${alias} label`);
  }
  // A 1M-context alias names the same model as its base alias.
  assert.equal(catalogLabel('sonnet[1m]'), `${catalogLabel('sonnet')} (1M context)`);
  assert.equal(catalogLabel('opus[1m]'), `${catalogLabel('opus')} (1M context)`);
});

test('aliases stay unversioned, so they keep following the newest model of each family', () => {
  for (const option of CLAUDE_PREDEFINED_MODELS.OPTIONS) {
    assert.doesNotMatch(option.value.replace(/\[1m\]$/, ''), /\d/, `${option.value} is a versioned id, not an alias`);
  }
});

test('the composite choices describe the same versions as the family rows', () => {
  const best = CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === 'best');
  assert.ok(best?.description?.includes(catalogLabel('fable')), 'best names the Fable version');
  assert.ok(best?.description?.includes(catalogLabel('opus')), 'best names the Opus version');

  const opusPlan = CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === 'opusplan');
  assert.ok(opusPlan?.description?.includes(catalogLabel('opus')), 'opusplan names the Opus version');
  assert.ok(opusPlan?.description?.includes(catalogLabel('sonnet')), 'opusplan names the Sonnet version');
});
