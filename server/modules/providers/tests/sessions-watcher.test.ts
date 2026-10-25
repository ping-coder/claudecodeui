import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import chokidar from 'chokidar';

import {
  createAgyWatcherIgnoredMatcher,
  createWatcherIgnoredMatcher,
  isWatcherTargetFile,
} from '@/modules/providers/services/sessions-watcher.service.js';

const AGY_CONVERSATION_ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';

test('the ignored matcher skips build output, VCS data, subagents and tool results', () => {
  const root = path.join(os.tmpdir(), 'watch-root');
  const isIgnored = createWatcherIgnoredMatcher(root);

  assert.equal(isIgnored(path.join(root, '-home-me-app', 'abc.jsonl')), false);
  assert.equal(isIgnored(path.join(root, '-home-me-app', 'abc', 'subagents', 'agent-1.jsonl')), true);
  assert.equal(isIgnored(path.join(root, '-home-me-app', 'abc', 'tool-results', 'out.txt')), true);
  assert.equal(isIgnored(path.join(root, 'pkg', 'node_modules', 'dep', 'index.js')), true);
  assert.equal(isIgnored(path.join(root, 'repo', '.git', 'HEAD')), true);
  assert.equal(isIgnored(path.join(root, '-home-me-app', 'abc.jsonl.tmp')), true);
  assert.equal(isIgnored(path.join(root, '-home-me-app', '.DS_Store')), true);
});

test('the ignored matcher never looks above its own root', () => {
  // A home directory under /build or /dist must not hide a whole provider.
  const root = path.join(os.tmpdir(), 'build', 'home', '.claude', 'projects');
  const isIgnored = createWatcherIgnoredMatcher(root);

  assert.equal(isIgnored(root), false);
  assert.equal(isIgnored(path.join(root, '-home-me-app', 'abc.jsonl')), false);
  // Paths outside the root are never judged, whatever their names.
  assert.equal(isIgnored(path.join(root, '..', 'node_modules', 'x.js')), false);
});

test('a child whose name starts with two dots is still inside the root', () => {
  const root = path.join(os.tmpdir(), 'watch-root');
  const isIgnored = createWatcherIgnoredMatcher(root);

  assert.equal(isIgnored(path.join(root, '..archive', 'node_modules', 'x.js')), true);
  assert.equal(isIgnored(path.join(root, '..archive', 'abc.jsonl')), false);
});

test('chokidar reports only session files through the matcher (#1156)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sessions-watcher-'));
  const files = [
    path.join('-home-me-app', 'abc.jsonl'),
    path.join('-home-me-app', 'abc', 'subagents', 'agent-1.jsonl'),
    path.join('-home-me-app', 'abc', 'tool-results', 'out.txt'),
    path.join('pkg', 'node_modules', 'dep', 'index.js'),
  ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), '{}\n');
  }

  const watcher = chokidar.watch(root, {
    ignored: createWatcherIgnoredMatcher(root),
    ignoreInitial: false,
    persistent: true,
  });
  const added: string[] = [];
  watcher.on('add', (filePath: string) => {
    added.push(path.relative(root, filePath));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', () => resolve());
      watcher.once('error', reject);
    });
    assert.deepEqual(added, [path.join('-home-me-app', 'abc.jsonl')]);
  } finally {
    await watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the agy matcher watches only the index, its WAL and the way down to each transcript', () => {
  const root = path.join(os.tmpdir(), 'agy-watch-root');
  const isIgnored = createAgyWatcherIgnoredMatcher(root);
  const conversation = path.join(root, 'brain', AGY_CONVERSATION_ID);
  const logs = path.join(conversation, '.system_generated', 'logs');

  for (const watched of [
    root,
    path.join(root, 'conversation_summaries.db'),
    path.join(root, 'conversation_summaries.db-wal'),
    path.join(root, 'brain'),
    conversation,
    path.join(conversation, '.system_generated'),
    logs,
    path.join(logs, 'transcript_full.jsonl'),
    path.join(logs, 'transcript.jsonl'),
  ]) {
    assert.equal(isIgnored(watched), false, watched);
  }

  for (const ignored of [
    // Reading the index touches the -shm; reacting to it would loop.
    path.join(root, 'conversation_summaries.db-shm'),
    path.join(root, 'conversations'),
    path.join(root, 'conversations', `${AGY_CONVERSATION_ID}.db`),
    path.join(root, 'bin', 'agy'),
    path.join(root, 'log', 'cli.log'),
    path.join(root, 'brain', 'not-a-conversation-id'),
    path.join(conversation, 'scratch'),
    path.join(conversation, '.user_uploaded', 'shot.png'),
    path.join(conversation, 'chunks'),
    path.join(conversation, 'tasks'),
    path.join(conversation, '.system_generated', 'steps'),
    path.join(conversation, '.system_generated', 'messages'),
    path.join(logs, 'other.log'),
    path.join(logs, 'transcript_full.jsonl.tmp'),
  ]) {
    assert.equal(isIgnored(ignored), true, ignored);
  }

  // Paths outside the root are never judged.
  assert.equal(isIgnored(path.join(root, '..', 'elsewhere', 'file')), false);
});

test('only agy\'s index, its WAL and transcripts count as agy session files', () => {
  const root = path.join(os.tmpdir(), 'agy-watch-root');
  const logs = path.join(root, 'brain', AGY_CONVERSATION_ID, '.system_generated', 'logs');

  assert.equal(isWatcherTargetFile('agy', path.join(root, 'conversation_summaries.db')), true);
  assert.equal(isWatcherTargetFile('agy', path.join(root, 'conversation_summaries.db-wal')), true);
  assert.equal(isWatcherTargetFile('agy', path.join(logs, 'transcript_full.jsonl')), true);
  assert.equal(isWatcherTargetFile('agy', path.join(logs, 'transcript.jsonl')), true);
  assert.equal(isWatcherTargetFile('agy', path.join(root, 'conversation_summaries.db-shm')), false);
  assert.equal(isWatcherTargetFile('agy', path.join(root, 'history.jsonl')), false);
  assert.equal(isWatcherTargetFile('agy', path.join(root, 'brain', AGY_CONVERSATION_ID, 'transcript.jsonl')), false);

  // The other providers keep their rules.
  assert.equal(isWatcherTargetFile('claude', path.join(root, 'abc.jsonl')), true);
  assert.equal(isWatcherTargetFile('opencode', path.join(root, 'opencode.db')), true);
  assert.equal(isWatcherTargetFile('opencode', path.join(root, 'abc.jsonl')), false);
});

test('chokidar at depth 4 reports only agy\'s index, WAL and transcripts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-sessions-watcher-'));
  const logs = path.join('brain', AGY_CONVERSATION_ID, '.system_generated', 'logs');
  const watchedFiles = [
    'conversation_summaries.db',
    'conversation_summaries.db-wal',
    path.join(logs, 'transcript.jsonl'),
    path.join(logs, 'transcript_full.jsonl'),
  ];
  const noise = [
    'conversation_summaries.db-shm',
    path.join('conversations', `${AGY_CONVERSATION_ID}.db`),
    path.join('brain', AGY_CONVERSATION_ID, 'scratch', 'notes.md'),
    path.join('brain', AGY_CONVERSATION_ID, '.system_generated', 'steps', '1.json'),
    path.join('log', 'cli.log'),
  ];
  for (const file of [...watchedFiles, ...noise]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), '{}\n');
  }

  const watcher = chokidar.watch(root, {
    ignored: createAgyWatcherIgnoredMatcher(root),
    ignoreInitial: false,
    persistent: true,
    depth: 4,
  });
  const added: string[] = [];
  watcher.on('add', (filePath: string) => {
    added.push(path.relative(root, filePath));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', () => resolve());
      watcher.once('error', reject);
    });
    assert.deepEqual(added.sort(), [...watchedFiles].sort());
  } finally {
    await watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});
