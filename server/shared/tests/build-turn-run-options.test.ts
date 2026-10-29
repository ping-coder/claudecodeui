import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTurnRunOptions } from '@/shared/utils.js';

test('a client\'s acceptProcessSettings never reaches a turn\'s run options, whatever its value', () => {
  for (const value of [true, false, 'true', 1]) {
    const options = buildTurnRunOptions({
      sessionId: 'session-1',
      projectPath: '/projects/app',
      clientOptions: { model: 'opus', effort: 'max', acceptProcessSettings: value },
    });
    assert.equal('acceptProcessSettings' in options, false, String(value));
    assert.equal(options.model, 'opus');
    assert.equal(options.effort, 'max');
  }
});

test('the gateway\'s own acceptProcessSettings, passed as an extra option, is kept', () => {
  const options = buildTurnRunOptions({
    sessionId: 'session-1',
    projectPath: '/projects/app',
    clientOptions: { effort: 'max', acceptProcessSettings: false },
    extraOptions: { acceptProcessSettings: true },
  });
  assert.equal(options.acceptProcessSettings, true);
  assert.equal(options.effort, 'max');
  assert.equal(options.cwd, '/projects/app');
  assert.equal(options.sessionId, 'session-1');
});
