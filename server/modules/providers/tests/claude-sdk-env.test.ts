import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaudeSdkEnv } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Claude Code turns the Artifact tools off for SDK-driven sessions unless
// CLAUDE_CODE_ARTIFACT is set, so a UI session would lose them mid-conversation.
test('SDK sessions opt into the Artifact tools by default', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ARTIFACT, '1');
});

test('a host CLAUDE_CODE_ARTIFACT value wins over the default', () => {
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ARTIFACT: '0' }).CLAUDE_CODE_ARTIFACT, '0');
});

test('host env vars are still forwarded', () => {
  assert.equal(buildClaudeSdkEnv({ ANTHROPIC_BASE_URL: 'http://proxy' }).ANTHROPIC_BASE_URL, 'http://proxy');
});

// The Claude history reader tells CloudCLI's own launches from another CLI
// process's by the entrypoint stamped on them, so CloudCLI's runs must write
// the same one whatever CloudCLI inherited. An inherited `cli` would even be
// rewritten to `sdk-cli` by the CLI, as an SDK run has no terminal.
test('SDK sessions always run under CloudCLI\'s own entrypoint', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ENTRYPOINT: 'cli' }).CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ENTRYPOINT: 'local-agent' }).CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
});

// Once CloudCLI closes the CLI's stdin it no longer needs the process, and a
// process with stdin closed cannot be told to stop anything. A host value
// would only keep that work around longer; 0 would keep it forever.
test('the CLI\'s background-work ceiling is always CloudCLI\'s five minutes', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '300000');
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '300000');
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '7200000' }).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '300000');
});
