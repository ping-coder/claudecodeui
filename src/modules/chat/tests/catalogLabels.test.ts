import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import {
  BUILTIN_COMMAND_DESCRIPTIONS,
  EFFORT_LEVEL_KEYS,
  MODEL_DESCRIPTION_KEYS,
  MODEL_LABEL_KEYS,
  describeCommandType,
  describeEffortLevel,
  describeModelDescription,
  describeModelOption,
  describeSlashCommand,
} from '@/modules/chat/utils/catalogLabels';

/**
 * The words the server sends in English (effort levels, the built-in catalog's
 * worded model names, the built-in slash commands) read in the interface
 * language when this client knows them, and as sent when it does not. The
 * English the client matches on is the server's own, checked against its source.
 */

const zh = i18n.getFixedT('zh-CN');
const en = i18n.getFixedT('en');

// Resolved from this file's path: under jsdom, URL is jsdom's class, which node:url does not accept.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const readServerFile = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

/** `ns:key` split for getResource, which reads one language's file with no fallback. */
const resourceIn = (language: string, fullKey: string): unknown => {
  const [ns, key] = fullKey.split(':');
  return i18n.getResource(language, ns, key);
};

const ALL_KEYS = [
  ...EFFORT_LEVEL_KEYS.values(),
  ...MODEL_LABEL_KEYS.values(),
  'chat:modelCatalog.contextVariant',
  ...MODEL_DESCRIPTION_KEYS.values(),
  ...[...BUILTIN_COMMAND_DESCRIPTIONS.values()].map((entry) => entry.key),
  'chat:slashCommands.builtinBadge',
];

describe('effort levels', () => {
  it('read in the interface language, the default choice included', () => {
    assert.equal(describeEffortLevel('xhigh', zh), '超高');
    assert.equal(describeEffortLevel('low', zh), '低');
    assert.equal(describeEffortLevel('default', zh), '默认');
  });

  it('read in English as the catalog names them, so the English interface is unchanged', () => {
    for (const level of EFFORT_LEVEL_KEYS.keys()) {
      assert.equal(describeEffortLevel(level, en), level);
    }
    assert.equal(describeEffortLevel('default', en), 'Default');
  });

  it('show a level this client does not know as the catalog sends it', () => {
    assert.equal(describeEffortLevel('turbo', zh), 'turbo');
    assert.equal(describeEffortLevel('constructor', zh), 'constructor');
  });

  it('cover every level the server lets a provider declare', () => {
    const capabilities = readServerFile('server/modules/providers/services/provider-capabilities.service.ts');
    const declared = new Set(
      [...capabilities.matchAll(/effortLevels: \[([^\]]*)\]/g)].flatMap((match) => [...match[1].matchAll(/'([\w-]+)'/g)].map((level) => level[1])),
    );
    assert.equal(declared.size > 0, true);
    assert.deepEqual([...declared].filter((level) => !EFFORT_LEVEL_KEYS.has(level)), []);
  });
});

describe('model names', () => {
  it('read the built-in catalog\'s worded names in the interface language', () => {
    assert.equal(describeModelOption({ value: 'default', label: 'Default (recommended)' }, zh), '默认（推荐）');
    assert.equal(describeModelOption({ value: 'best', label: 'Best available' }, zh), '最佳可用');
    assert.equal(describeModelOption({ value: 'auto', label: 'Auto' }, zh), '自动');
    assert.equal(describeModelOption({ value: 'sonnet[1m]', label: 'Sonnet 5.5 (1M context)' }, zh), 'Sonnet 5.5（1M 上下文）');
  });

  it('keep model names, custom models and names this client does not know as sent', () => {
    assert.equal(describeModelOption({ value: 'opus', label: 'Opus 5.5' }, zh), 'Opus 5.5');
    assert.equal(describeModelOption({ value: 'opusplan', label: 'Opus Plan' }, zh), 'Opus Plan');
    assert.equal(describeModelOption({ value: 'mine', label: 'Default (recommended)', isCustom: true }, zh), 'Default (recommended)');
    assert.equal(describeModelOption({ value: 'raw-id', label: '' }, zh), 'raw-id');
  });

  it('leave the English interface as the catalog has it', () => {
    for (const label of [...MODEL_LABEL_KEYS.keys(), 'Opus 5.5 (1M context)']) {
      assert.equal(describeModelOption({ value: 'x', label }, en), label);
    }
  });

  it('match names the server\'s catalogs still send', () => {
    const catalogs = [
      'server/modules/providers/list/claude/claude-models.provider.ts',
      'server/modules/providers/list/cursor/cursor-models.provider.ts',
    ].map(readServerFile).join('\n');
    const labels = new Set([...catalogs.matchAll(/label: '([^']+)'/g)].map((match) => match[1]));
    assert.deepEqual([...MODEL_LABEL_KEYS.keys()].filter((label) => !labels.has(label)), []);
    assert.equal(labels.has('Sonnet 5.5 (1M context)'), true);
  });
});

describe('model descriptions', () => {
  it('describe a built-in model in the interface language, and English as the catalog has it', () => {
    const sonnet = { description: 'Latest Sonnet model for everyday coding tasks.' };
    assert.equal(describeModelDescription(sonnet, zh), '最新的 Sonnet 模型，适合日常编码。');
    for (const english of MODEL_DESCRIPTION_KEYS.keys()) {
      assert.equal(describeModelDescription({ description: english }, en), english);
    }
  });

  it('keep a custom model\'s, an unknown one and none as sent', () => {
    assert.equal(describeModelDescription({ description: 'Latest Sonnet model for everyday coding tasks.', isCustom: true }, zh), 'Latest Sonnet model for everyday coding tasks.');
    assert.equal(describeModelDescription({ description: 'Latest Sonnet 6 model.' }, zh), 'Latest Sonnet 6 model.');
    assert.equal(describeModelDescription({ description: 'OpenCode Zen' }, zh), 'OpenCode Zen');
    assert.equal(describeModelDescription({}, zh), undefined);
  });

  it('match the descriptions the server\'s catalogs send, every one of them', () => {
    const catalogs = ['claude', 'codex', 'cursor']
      .map((provider) => readServerFile(`server/modules/providers/list/${provider}/${provider}-models.provider.ts`))
      .join('\n');
    const sent = new Set([...catalogs.matchAll(/description: '([^']+)'/g)].map((match) => match[1]));
    assert.deepEqual([...MODEL_DESCRIPTION_KEYS.keys()].filter((english) => !sent.has(english)), []);
    assert.deepEqual([...sent].filter((english) => !MODEL_DESCRIPTION_KEYS.has(english)), []);
  });
});

describe('built-in slash commands', () => {
  it('describe a built-in command in the interface language, with its badge', () => {
    const help = { name: '/help', description: 'Show help documentation for Claude Code', namespace: 'builtin', metadata: { type: 'builtin' } };
    assert.equal(describeSlashCommand(help, zh), '查看 Claude Code 的帮助文档');
    assert.equal(describeCommandType('builtin', zh), '内置');
    assert.equal(describeSlashCommand(help, en), help.description);
    assert.equal(describeCommandType('builtin', en), 'builtin');
  });

  it('keep other commands, and a built-in the server now describes otherwise, as sent', () => {
    assert.equal(describeSlashCommand({ name: '/help', description: 'Show help documentation for Claude Code', namespace: 'project' }, zh), 'Show help documentation for Claude Code');
    assert.equal(describeSlashCommand({ name: '/help', description: 'Something new', namespace: 'builtin' }, zh), 'Something new');
    assert.equal(describeSlashCommand({ name: '/deploy', description: 'Ship it', namespace: 'builtin' }, zh), 'Ship it');
    assert.equal(describeSlashCommand({ name: '/help', namespace: 'builtin' }, zh), undefined);
    assert.equal(describeCommandType('project', zh), 'project');
  });

  it('know every built-in command by the description the server lists it with', () => {
    const routes = readServerFile('server/modules/commands/commands.routes.ts');
    const block = routes.slice(routes.indexOf('const builtInCommands = ['), routes.indexOf('];', routes.indexOf('const builtInCommands = [')));
    const fromServer = Object.fromEntries(
      [...block.matchAll(/name: "([^"]+)",\s*description: "([^"]+)"/g)].map((match) => [match[1], match[2]]),
    );
    const known = Object.fromEntries([...BUILTIN_COMMAND_DESCRIPTIONS].map(([name, entry]) => [name, entry.english]));
    assert.deepEqual(known, fromServer);
    for (const entry of BUILTIN_COMMAND_DESCRIPTIONS.values()) {
      assert.equal(en(entry.key), entry.english);
    }
  });
});

it('has every key in English, Simplified Chinese and Hebrew', () => {
  for (const language of ['en', 'zh-CN', 'he']) {
    assert.deepEqual(ALL_KEYS.filter((key) => typeof resourceIn(language, key) !== 'string'), [], language);
  }
});
