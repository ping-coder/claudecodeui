import assert from 'node:assert/strict';

import { test } from 'vitest';

import { i18n } from '@/modules/i18n';
import { getDeploymentEnvironmentLabel } from '@/shared/utils';

/**
 * The label leads the tab title and fills the environment badge. Well-known ids
 * get a translated name, whatever case the operator typed them in; anything else
 * is shown exactly as configured, so an unusual environment is never hidden.
 */

const labelsIn = (language: string, environments: string[]) => {
  const t = i18n.getFixedT(language, 'common');
  return environments.map((environment) => getDeploymentEnvironmentLabel(environment, t));
};

test('staging and its aliases read "Stage" in English and "预发布" in Chinese', () => {
  const aliases = ['staging', 'stage', 'preprod', 'pre-production'];

  assert.deepEqual(labelsIn('en', aliases), ['Stage', 'Stage', 'Stage', 'Stage']);
  assert.deepEqual(labelsIn('zh-CN', aliases), ['预发布', '预发布', '预发布', '预发布']);
});

test('development and test ids have their own translated labels', () => {
  const environments = ['development', 'dev', 'test', 'testing'];

  assert.deepEqual(labelsIn('en', environments), ['Dev', 'Dev', 'Test', 'Test']);
  assert.deepEqual(labelsIn('zh-CN', environments), ['开发', '开发', '测试', '测试']);
});

test('well-known ids match regardless of case and surrounding whitespace', () => {
  assert.deepEqual(labelsIn('en', ['Staging', 'STAGE', ' PreProd ', 'DEV']), ['Stage', 'Stage', 'Stage', 'Dev']);
});

test('any other id is shown exactly as configured, in every language', () => {
  const environments = ['qa-east-1', 'Canary', 'constructor'];

  assert.deepEqual(labelsIn('en', environments), environments);
  assert.deepEqual(labelsIn('zh-CN', environments), environments);
});

test('languages without their own label fall back to English', () => {
  assert.deepEqual(labelsIn('de', ['staging', 'dev']), ['Stage', 'Dev']);
});

test('a t bound to another namespace still reads the label from common', () => {
  // The sidebar hands its components a t that defaults to the sidebar namespace.
  assert.equal(getDeploymentEnvironmentLabel('staging', i18n.getFixedT('zh-CN', ['sidebar', 'common'])), '预发布');
});
