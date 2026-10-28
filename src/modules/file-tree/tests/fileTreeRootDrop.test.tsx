import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * Regression guard for a 403 on a file dropped onto a top-level file row: the row named its
 * parent folder, the project root, by its absolute path, and the upload endpoint refused the
 * root itself as outside the project. A top-level row now sends the root as an empty relative
 * path, like a drop on empty space; deeper rows and folders keep naming their folder.
 */

const ROOT = '/home/u/demo';
const tree = [
  {
    type: 'directory',
    name: 'src',
    path: `${ROOT}/src`,
    children: [{ type: 'file', name: 'index.ts', path: `${ROOT}/src/index.ts` }],
  },
  { type: 'file', name: 'README.md', path: `${ROOT}/README.md` },
];

const getFiles = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    getFiles: (...args: unknown[]) => getFiles(...args),
    uploadFilesUrl: (projectId: string) => `/api/file-tree/projects/${projectId}/files/upload`,
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'demo', fullPath: ROOT, path: ROOT };

// The `targetPath` field of every upload request sent.
let sentTargets: Array<FormDataEntryValue | null> = [];

/** Records what an upload would send and leaves the request pending; the response does not matter here. */
class RecordingUploadRequest {
  upload = { onprogress: null };

  open() {}

  setRequestHeader() {}

  send(body: FormData) {
    sentTargets.push(body.get('targetPath'));
  }
}

const originalXMLHttpRequest = globalThis.XMLHttpRequest;

beforeEach(() => {
  sentTargets = [];
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: true, json: async () => tree });
  globalThis.XMLHttpRequest = RecordingUploadRequest as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  globalThis.XMLHttpRequest = originalXMLHttpRequest;
});

const renderTree = async () => {
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.equal(screen.queryByText('README.md') !== null, true));
};

/** Drags a file over the row of `name` and returns what the drop overlay says. */
const dragOverRow = (name: string) => {
  const row = screen.getByText(name);
  fireEvent.dragEnter(row);
  fireEvent.dragOver(row);
  return screen.queryByText(/^Drop files to upload/)?.textContent ?? null;
};

/** Drops one file on the row of `name` and returns the `targetPath` its upload sent. */
const dropOnRow = async (name: string) => {
  const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  // An item without a filesystem entry, so the drop reads it with getAsFile().
  const item = { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file };
  fireEvent.drop(screen.getByText(name), { dataTransfer: { items: [item], files: [file] } });
  await waitFor(() => assert.equal(sentTargets.length, 1));
  const [target] = sentTargets;
  sentTargets = [];
  return target;
};

test('a file dropped onto a top-level file row is uploaded into the project root', async () => {
  await renderTree();

  const overlay = dragOverRow('README.md');
  assert.equal(await dropOnRow('README.md'), '');
  // The overlay names no folder, as over empty space: the target is the root.
  assert.equal(overlay, 'Drop files to upload');
});

test('deeper file rows and folder rows still upload into their folder', async () => {
  await renderTree();
  fireEvent.click(screen.getByText('src'));
  await waitFor(() => assert.equal(screen.queryByText('index.ts') !== null, true));

  assert.equal(dragOverRow('index.ts'), 'Drop files to upload to "src"');
  assert.equal(await dropOnRow('index.ts'), `${ROOT}/src`);

  assert.equal(dragOverRow('src'), 'Drop files to upload to "src"');
  assert.equal(await dropOnRow('src'), `${ROOT}/src`);
});
