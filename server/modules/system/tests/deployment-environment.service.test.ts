import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDeploymentEnvironment } from '../deployment-environment.service.js';

// `/health` reports this value as `environment`, and the web UI shows a marker
// for any non-null value, so every production spelling must come out as null.

test('an unset or blank CLOUDCLI_DEPLOY_ENV means production', () => {
  assert.equal(resolveDeploymentEnvironment(undefined), null);
  assert.equal(resolveDeploymentEnvironment(''), null);
  assert.equal(resolveDeploymentEnvironment('   '), null);
});

test('production and prod mean production in any case and with surrounding whitespace', () => {
  for (const value of ['production', 'prod', 'Production', 'PROD', '  production\n']) {
    assert.equal(resolveDeploymentEnvironment(value), null, `${JSON.stringify(value)} is production`);
  }
});

test('a non-production name is reported trimmed, with its case kept', () => {
  assert.equal(resolveDeploymentEnvironment('staging'), 'staging');
  assert.equal(resolveDeploymentEnvironment('  Staging  '), 'Staging');
  assert.equal(resolveDeploymentEnvironment('qa-east-1'), 'qa-east-1');
});

test('a name that merely contains "prod" is not production', () => {
  assert.equal(resolveDeploymentEnvironment('preprod'), 'preprod');
  assert.equal(resolveDeploymentEnvironment('pre-production'), 'pre-production');
});
