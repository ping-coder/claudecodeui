import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { FolderBrowserModal } from '@/shared/ui';
import type { FolderBrowseResult } from '@/shared/types';

/**
 * The folder browser lists folders through whatever endpoint its caller injects: it starts where it
 * is told, goes up to the parent the endpoint reports (or works it out from the path), offers to
 * create a folder only when the caller can, and shows the endpoint's refusal.
 */

const listing = (path: string, parent: string | null | undefined, names: string[]): FolderBrowseResult => ({
  path,
  ...(parent === undefined ? {} : { parent }),
  folders: names.map((name) => ({ name, path: `${path}/${name}` })),
});

test('it starts at the given folder and goes up to the parent the endpoint reports', async () => {
  const browse = vi.fn(async (folderPath: string | null) => (folderPath === '/mnt'
    ? listing('/mnt', null, ['media'])
    : listing('/mnt/media', '/mnt', ['clips'])));
  render(<FolderBrowserModal isOpen onClose={() => undefined} onFolderSelected={() => undefined} browse={browse} initialPath="/mnt/media" />);

  await waitFor(() => assert.equal(screen.queryByText('clips') !== null, true));
  assert.equal(browse.mock.calls[0][0], '/mnt/media');

  fireEvent.click(screen.getByText('..'));
  await waitFor(() => assert.equal(screen.queryByText('media') !== null, true));
  assert.equal(browse.mock.calls[1][0], '/mnt');
  // The endpoint says /mnt is as high as it goes.
  assert.equal(screen.queryByText('..') === null, true);
});

test('without a reported parent, the parent comes from the path', async () => {
  const browse = vi.fn(async (folderPath: string | null) => listing(folderPath ?? '/home/u', undefined, []));
  render(<FolderBrowserModal isOpen onClose={() => undefined} onFolderSelected={() => undefined} browse={browse} initialPath="/home/u/work" />);

  await waitFor(() => assert.equal(screen.queryByText('..') !== null, true));
  fireEvent.click(screen.getByText('..'));
  await waitFor(() => assert.equal(browse.mock.calls[1][0], '/home/u'));
});

test('a folder is created only through the caller, in the folder shown', async () => {
  const browse = vi.fn(async (folderPath: string | null) => listing(folderPath ?? '/home/u', null, []));
  const { unmount } = render(<FolderBrowserModal isOpen onClose={() => undefined} onFolderSelected={() => undefined} browse={browse} initialPath={null} />);
  await waitFor(() => assert.equal(browse.mock.calls.length, 1));
  assert.equal(browse.mock.calls[0][0], null);
  assert.equal(screen.queryByTitle('Create new folder') === null, true);
  unmount();

  const createFolder = vi.fn(async (parentPath: string, name: string) => `${parentPath}/${name}`);
  render(<FolderBrowserModal isOpen onClose={() => undefined} onFolderSelected={() => undefined} browse={browse} createFolder={createFolder} initialPath={null} />);
  await waitFor(() => assert.equal(screen.queryByTitle('Create new folder') !== null, true));
  fireEvent.click(screen.getByTitle('Create new folder'));
  fireEvent.change(screen.getByPlaceholderText('New folder name'), { target: { value: ' big ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));

  await waitFor(() => assert.equal(createFolder.mock.calls.length, 1));
  assert.deepEqual(createFolder.mock.calls[0], ['/home/u', 'big']);
  await waitFor(() => assert.equal(browse.mock.calls.some((call) => call[0] === '/home/u/big'), true));
});

test('the endpoint\'s refusal is shown, and the folder asked for can still be left upwards', async () => {
  const browse = vi.fn(async (folderPath: string | null) => {
    if (folderPath === '/etc') {
      throw new Error('System folders cannot be mounted.');
    }
    return listing(folderPath ?? '/', null, []);
  });
  const onFolderSelected = vi.fn();
  render(<FolderBrowserModal isOpen onClose={() => undefined} onFolderSelected={onFolderSelected} browse={browse} initialPath="/etc" />);

  await waitFor(() => assert.equal(screen.queryByText('System folders cannot be mounted.') !== null, true));
  assert.equal(screen.queryByText('..') !== null, true);

  fireEvent.click(screen.getByText('..'));
  await waitFor(() => assert.equal(browse.mock.calls[1][0], '/'));
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
  assert.deepEqual(onFolderSelected.mock.calls[0], ['/', false]);
});

test('a folder opened before the last one answered aborts that listing, whose late answer is dropped', async () => {
  let answerHugeFolder: (result: FolderBrowseResult) => void = () => undefined;
  const browse = vi.fn((folderPath: string | null, _options: { signal: AbortSignal }) => {
    if (folderPath === '/data/huge') {
      return new Promise<FolderBrowseResult>((resolve) => {
        answerHugeFolder = resolve;
      });
    }
    if (folderPath === '/data/small') {
      return Promise.resolve(listing('/data/small', '/data', ['kept']));
    }
    return Promise.resolve({ ...listing('/data', '/', ['huge', 'small']), notice: 'Only part of /data is listed.' });
  });
  render(<FolderBrowserModal isOpen onClose={() => undefined} onFolderSelected={() => undefined} browse={browse} initialPath="/data" />);
  await waitFor(() => assert.equal(screen.queryByText('huge') !== null, true));
  // What the endpoint says about the folder shown.
  assert.equal(screen.queryByText('Only part of /data is listed.') !== null, true);

  fireEvent.click(screen.getByText('huge'));
  await waitFor(() => assert.equal(browse.mock.calls.length, 2));
  fireEvent.click(screen.getByText('small'));
  await waitFor(() => assert.equal(screen.queryByText('kept') !== null, true));
  assert.equal(browse.mock.calls[1][1].signal.aborted, true);
  assert.equal(screen.queryByText('Only part of /data is listed.') === null, true);

  answerHugeFolder(listing('/data/huge', '/data', ['stale']));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByText('stale') === null, true);
  assert.equal(screen.queryByText('kept') !== null, true);
});

test('closing the browser aborts the listing on its way', async () => {
  const browse = vi.fn((_folderPath: string | null, _options: { signal: AbortSignal }) => new Promise<FolderBrowseResult>(() => undefined));
  const { rerender } = render(<FolderBrowserModal isOpen onClose={() => undefined} onFolderSelected={() => undefined} browse={browse} initialPath="/data" />);
  await waitFor(() => assert.equal(browse.mock.calls.length, 1));
  assert.equal(browse.mock.calls[0][1].signal.aborted, false);

  rerender(<FolderBrowserModal isOpen={false} onClose={() => undefined} onFolderSelected={() => undefined} browse={browse} initialPath="/data" />);
  assert.equal(browse.mock.calls[0][1].signal.aborted, true);
});
