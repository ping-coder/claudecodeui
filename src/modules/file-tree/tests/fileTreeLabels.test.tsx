import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * The file tree's counted and typed labels come whole from the locale files: the upload toast
 * and the progress line pick the plural form for the number of files, and the delete dialog has
 * one title for a folder and one for a file, instead of an English "file(s)" or "Folder" put into
 * a translated sentence. Spanish and Czech keep their unsuffixed "uploadedCount" string, which
 * reads {{total}}.
 */

const ROOT = '/home/u/demo';
const tree = [
  { type: 'directory', name: 'src', path: `${ROOT}/src`, children: [] },
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

// What the server reports for the next answered upload, and the uploads still waiting for an answer.
let reply = { uploadedCount: 0, requestedFileCount: 0 };
let waiting: Array<() => void> = [];

/** Holds an upload until the test answers it with `reply`. */
class HeldUploadRequest {
  upload = { onprogress: null };

  status = 200;

  responseText = '';

  onload: (() => void) | null = null;

  open() {}

  setRequestHeader() {}

  getResponseHeader() {
    return null;
  }

  send() {
    waiting.push(() => {
      this.responseText = JSON.stringify(reply);
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

/** How many elements show exactly `text`. */
const shown = (text: string) => screen.queryAllByText(text).length;

/** Drops `count` files on the tree, then answers the upload with what the server reports. */
const dropFiles = async (count: number) => {
  const files = Array.from({ length: count }, (_, index) => new File(['x'], `note-${index}.txt`, { type: 'text/plain' }));
  // Items without a filesystem entry, so the drop reads them with getAsFile().
  const items = files.map((file) => ({ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file }));
  fireEvent.drop(screen.getByText('README.md'), { dataTransfer: { items, files } });
  await waitFor(() => assert.equal(waiting.length, 1));
};

const answerUpload = async (uploadedCount: number, requestedFileCount: number) => {
  reply = { uploadedCount, requestedFileCount };
  await act(async () => {
    waiting.shift()?.();
  });
};

/** Opens the delete dialog of the row named `name` from its context menu, reads its title and cancels. */
const deleteDialogTitle = async (name: string) => {
  fireEvent.contextMenu(screen.getByText(name), { clientX: 20, clientY: 20 });
  fireEvent.click(screen.getByRole('menuitem', { name: i18n.t('fileTree.context.delete') }));
  const cancel = screen.getByRole('button', { name: i18n.t('common.cancel') });
  // The dialog's own heading: the tree's header has one too.
  const title = within(cancel.closest('.fixed') as HTMLElement).getByRole('heading').textContent;
  fireEvent.click(cancel);
  return title;
};

test('an upload of several files counts them in the plural, in flight and when partly done', async () => {
  await renderTree();
  await dropFiles(3);
  assert.equal(shown('3 files'), 1);

  await answerUpload(2, 3);
  // The progress line and the toast say the same.
  await waitFor(() => assert.equal(shown('Uploaded 2 of 3 files'), 2));
});

test('a finished upload reports its files in the plural or the singular', async () => {
  await renderTree();
  await dropFiles(2);
  await answerUpload(2, 2);
  await waitFor(() => assert.equal(shown('Uploaded 2 files successfully'), 1));
  assert.equal(shown('Uploaded 2 of 2 files'), 1);

  await dropFiles(1);
  await answerUpload(1, 1);
  await waitFor(() => assert.equal(shown('Uploaded 1 file successfully'), 1));
  assert.equal(shown('Uploaded 1 of 1 file'), 1);
});

test('the delete dialog has a title for a folder and one for a file', async () => {
  await renderTree();
  assert.equal(await deleteDialogTitle('src'), 'Delete Folder');
  assert.equal(await deleteDialogTitle('README.md'), 'Delete File');
});

test.each([
  ['es', 'Se subieron 2 de 3 archivos', 'Eliminar carpeta', 'Eliminar archivo'],
  ['cs', 'Nahráno 2 z 3 souborů', 'Smazat složku', 'Smazat soubor'],
])('%s keeps its upload count and has both delete titles', async (language, uploaded, folderTitle, fileTitle) => {
  await renderTree(language);
  await dropFiles(3);
  await answerUpload(2, 3);
  await waitFor(() => assert.equal(shown(uploaded), 2));

  assert.equal(await deleteDialogTitle('src'), folderTitle);
  assert.equal(await deleteDialogTitle('README.md'), fileTitle);
});
