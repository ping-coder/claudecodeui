import assert from 'node:assert/strict';

import { test } from 'vitest';

import { buildModelRunOptions } from '@/shared/utils';

// One rule for a live send and a scheduled message alike: the ultracode switch
// travels only as a real choice for a model that can run it.

test.each([true, false])('an ultracode switch of %s is sent beside the model and effort', (ultracode) => {
  assert.deepEqual(
    buildModelRunOptions({ model: 'opus', effort: 'low', ultracode }),
    { model: 'opus', effort: 'low', ultracode },
  );
});

test.each([null, undefined])('a %s switch (the model cannot run ultracode) leaves the key out', (ultracode) => {
  const options = buildModelRunOptions({ model: 'default', effort: 'default', ultracode });

  assert.deepEqual(options, { model: 'default', effort: 'default' });
  assert.equal('ultracode' in options, false);
});
