import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { stripBidiIsolates } from '@/shared/direction';
import type { Project } from '@/shared/types';

/**
 * A failed upload says why in the UI language, in the toast and in the progress line alike. The
 * server words its own errors in English: they keep their words after a translated prefix. A lost
 * connection, a status with no reason, too many files, an oversized file and dropped files that
 * cannot be read each have a sentence of their own.
 */

const ROOT = '/home/u/demo';
const tree = [{ type: 'file', name: 'README.md', path: `${ROOT}/README.md` }];

const getFiles = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    getFiles: (...args: unknown[]) => getFiles(...args),
    uploadFilesUrl: (projectId: string) => `/api/file-tree/projects/${projectId}/files/upload`,
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'demo', fullPath: ROOT, path: ROOT };

type Outcome = { status: number; body: string } | 'network';

// Uploads sent and not answered yet.
let waiting: Array<(outcome: Outcome) => void> = [];

/** Holds an upload until the test ends it with a response or a network error. */
class HeldUploadRequest {
  upload = { onprogress: null };

  status = 0;

  responseText = '';

  onload: (() => void) | null = null;

  onerror: (() => void) | null = null;

  open() {}

  setRequestHeader() {}

  getResponseHeader() {
    return null;
  }

  send() {
    waiting.push((outcome) => {
      if (outcome === 'network') {
        this.onerror?.();
        return;
      }
      this.status = outcome.status;
      this.responseText = outcome.body;
      this.onload?.();
    });
  }
}

const originalXMLHttpRequest = globalThis.XMLHttpRequest;

beforeEach(() => {
  waiting = [];
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: true, json: async () => tree });
  globalThis.XMLHttpRequest = HeldUploadRequest as unknown as typeof XMLHttpRequest;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  globalThis.XMLHttpRequest = originalXMLHttpRequest;
  await i18n.changeLanguage('en');
});

const renderTree = async (language = 'en') => {
  await i18n.changeLanguage(language);
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.equal(screen.queryByText('README.md') !== null, true));
};

/** Whether the toast and the progress line both show exactly `text`. */
const toastAndProgressShow = (text: string) => screen.queryAllByText(text).length === 2;

const drop = (items: unknown[], files: File[] = []) => {
  fireEvent.drop(screen.getByText('README.md'), { dataTransfer: { items, files } });
};

/** Drops files that read without a filesystem entry, the way a plain file drag does. */
const dropFiles = (files: File[]) => {
  drop(files.map((file) => ({ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file })), files);
};

const textFile = (name: string) => new File(['x'], name, { type: 'text/plain' });

/** Drops one file and ends its upload with `outcome`. */
const failUpload = async (outcome: Outcome) => {
  dropFiles([textFile('note.txt')]);
  await waitFor(() => assert.equal(waiting.length === 1, true));
  await act(async () => {
    waiting.shift()?.(outcome);
  });
};

test('the server\'s own reason keeps its words after the prefix', async () => {
  await renderTree();
  await failUpload({ status: 400, body: JSON.stringify({ error: 'File too large. Maximum size is 200MB.' }) });
  await waitFor(() => assert.equal(toastAndProgressShow('Upload failed: File too large. Maximum size is 200MB.'), true));
});

test('a status with no reason, and a lost connection, have sentences of their own', async () => {
  await renderTree();
  await failUpload({ status: 502, body: '' });
  await waitFor(() => assert.equal(toastAndProgressShow('Upload failed (HTTP 502)'), true));

  await failUpload('network');
  await waitFor(() => assert.equal(toastAndProgressShow('Upload failed. Check your connection and try again.'), true));
});

test('too many files and an oversized file are refused before any request', async () => {
  await renderTree();
  dropFiles(Array.from({ length: 21 }, (_, index) => textFile(`note-${index}.txt`)));
  await waitFor(() => assert.equal(toastAndProgressShow('You can upload up to 20 files at once.'), true));

  const big = textFile('big.bin');
  Object.defineProperty(big, 'size', { value: 200 * 1024 * 1024 + 1 });
  dropFiles([big]);
  await waitFor(() => assert.equal(toastAndProgressShow('big.bin is larger than 200MB.'), true));
  assert.equal(waiting.length === 0, true);
});

test('dropped files that cannot be read say so without the browser\'s reason', async () => {
  await renderTree();
  const unreadable = {
    isFile: true,
    isDirectory: false,
    file: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error('NotReadableError: permission lost')),
  };
  drop([{ kind: 'file', webkitGetAsEntry: () => unreadable, getAsFile: () => null }]);
  await waitFor(() => assert.equal(toastAndProgressShow('Could not read the dropped files.'), true));
  assert.equal(screen.queryByText(/permission lost/) === null, true);
});

test('in Hebrew the messages come from the Hebrew locale and keep the server\'s words', async () => {
  const reason = 'Path traversal not allowed';
  await renderTree('he');
  await failUpload({ status: 403, body: JSON.stringify({ error: reason }) });

  const expected = i18n.t('fileTree.uploadError.server', { lng: 'he', error: reason });
  await waitFor(() => assert.equal(toastAndProgressShow(expected), true));
  // A Hebrew sentence, or the English one set apart as a fallback: either way not the bare English.
  assert.equal(expected !== `Upload failed: ${reason}`, true);
  assert.equal(stripBidiIsolates(expected).includes(reason), true);

  await failUpload('network');
  const offline = i18n.t('fileTree.uploadError.network', { lng: 'he' });
  await waitFor(() => assert.equal(toastAndProgressShow(offline), true));
  assert.equal(offline !== 'Upload failed. Check your connection and try again.', true);

  dropFiles(Array.from({ length: 21 }, (_, index) => textFile(`note-${index}.txt`)));
  const tooMany = i18n.t('fileTree.uploadError.tooMany', { lng: 'he', max: 20 });
  await waitFor(() => assert.equal(toastAndProgressShow(tooMany), true));
  assert.equal(tooMany !== 'You can upload up to 20 files at once.', true);
});
