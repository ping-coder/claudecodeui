import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { FileTreeNode, Project } from '@/shared/types';

/**
 * Mount roots in the Files tab. A registered mount lists as a folder of its own look whose tooltip
 * names the folder it links to; a broken one cannot be opened and offers Repair. Its menu unmounts
 * instead of renaming or deleting, folders in or above a mount are not zipped in the browser, and
 * deleting anything inside a mount warns in red that the real files outside the project go.
 * mounts/ itself holds only the links: nothing is created, uploaded, renamed or deleted there.
 */

const ROOT = '/home/u/demo';
const MOUNTS = `${ROOT}/mounts`;

const tree = [
  {
    type: 'directory',
    name: 'mounts',
    path: MOUNTS,
    children: [
      {
        type: 'directory',
        name: 'videos',
        path: `${MOUNTS}/videos`,
        isSymlink: true,
        mount: { mountId: 'm1', name: 'videos', targetPath: '/mnt/media/videos', status: 'ok' },
        children: [
          {
            type: 'directory',
            name: 'raw',
            path: `${MOUNTS}/videos/raw`,
            inMount: true,
            children: [{ type: 'file', name: 'take1.mov', path: `${MOUNTS}/videos/raw/take1.mov`, inMount: true }],
          },
          { type: 'file', name: 'cut.mp4', path: `${MOUNTS}/videos/cut.mp4`, inMount: true },
        ],
      },
      {
        type: 'directory',
        name: 'archive',
        path: `${MOUNTS}/archive`,
        isSymlink: true,
        mount: { mountId: 'm2', name: 'archive', targetPath: '/mnt/old/archive', status: 'missing-target' },
      },
    ],
  },
  { type: 'directory', name: 'src', path: `${ROOT}/src`, children: [] },
  { type: 'file', name: 'README.md', path: `${ROOT}/README.md` },
];

const { getFiles, deleteFile, renameFile, listMounts, removeMount, repairMount } = vi.hoisted(() => ({
  getFiles: vi.fn(),
  deleteFile: vi.fn(),
  renameFile: vi.fn(),
  listMounts: vi.fn(),
  removeMount: vi.fn(),
  repairMount: vi.fn(),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      getFiles: (...args: unknown[]) => getFiles(...args),
      deleteFile: (...args: unknown[]) => deleteFile(...args),
      renameFile: (...args: unknown[]) => renameFile(...args),
      uploadFilesUrl: (projectId: string) => `/api/file-tree/projects/${projectId}/files/upload`,
      mounts: {
        list: (...args: unknown[]) => listMounts(...args),
        remove: (...args: unknown[]) => removeMount(...args),
        repair: (...args: unknown[]) => repairMount(...args),
      },
    },
  };
});

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'demo', fullPath: ROOT, path: ROOT };

const renderTree = async () => {
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.equal(screen.queryByText('mounts') !== null, true));
  fireEvent.click(screen.getByText('mounts'));
  await waitFor(() => assert.equal(screen.queryByText('videos') !== null, true));
};

// The row element of an entry: the one carrying its padding, title and click handler.
const rowOf = (name: string) => screen.getByText(name).closest('[style]') as HTMLElement;

const mountIconOf = (name: string) => rowOf(name).querySelector('[data-mount-icon]')?.getAttribute('data-mount-icon') ?? null;

/** Opens the row's menu and returns its items' labels, with whether each is disabled. */
const openMenu = (name: string) => {
  fireEvent.contextMenu(screen.getByText(name), { clientX: 20, clientY: 20 });
  return screen.getAllByRole('menuitem').map((item) => ({
    label: item.textContent ?? '',
    disabled: (item as HTMLButtonElement).disabled,
  }));
};

const closeMenu = () => fireEvent.keyDown(document, { key: 'Escape' });

beforeEach(() => {
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: true, json: async () => tree });
  deleteFile.mockReset();
  deleteFile.mockResolvedValue(json({ success: true }));
  renameFile.mockReset();
  renameFile.mockResolvedValue(json({ success: true }));
  listMounts.mockReset();
  listMounts.mockImplementation(async () => json({ success: true, data: { mounts: [], adoptable: [] } }));
  removeMount.mockReset();
  removeMount.mockResolvedValue(json({ success: true, data: { removed: true, linkRemoved: true } }));
  repairMount.mockReset();
  repairMount.mockResolvedValue(json({ success: true, data: { mount: {} } }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

test('a mount has its own icon and its tooltip names the folder it links to', async () => {
  await renderTree();

  assert.equal(mountIconOf('videos'), 'ok');
  assert.equal(mountIconOf('src'), null);
  assert.equal(rowOf('videos').getAttribute('title'), 'Mounted folder → /mnt/media/videos');

  fireEvent.click(screen.getByText('videos'));
  await waitFor(() => assert.equal(screen.queryByText('cut.mp4') !== null, true));
});

test('a mount listed in part is not said to be too large, as its listing also stops on a share too slow to answer', async () => {
  const partlyListed = tree.map((node) => (node.name === 'mounts'
    ? {
        ...node,
        children: node.children?.map((child) => (child.name === 'videos' ? { ...child, truncated: true } : child)),
      }
    : node));
  getFiles.mockResolvedValue({ ok: true, json: async () => partlyListed });
  await renderTree();

  fireEvent.click(screen.getByText('videos'));
  await waitFor(() => assert.equal(screen.queryByText('cut.mp4') !== null, true));
  assert.equal(
    screen.queryByText('Not every file is listed: the mounted folder is too large or too slow to list in full.') !== null,
    true,
  );
});

test('a broken mount is drawn broken, cannot be opened and says what is wrong', async () => {
  await renderTree();

  assert.equal(mountIconOf('archive'), 'broken');
  assert.equal(rowOf('archive').querySelector('.lucide-chevron-right') === null, true);
  assert.equal(rowOf('archive').getAttribute('title')?.includes('/mnt/old/archive'), true);
  assert.equal(rowOf('archive').getAttribute('title')?.includes('Folder missing'), true);

  // A click does not record it as open: no chevron appears and nothing is listed under it.
  fireEvent.click(screen.getByText('archive'));
  assert.equal(rowOf('archive').querySelector('.lucide-chevron-right') === null, true);
});

test('a mount root unmounts instead of being renamed or deleted, and a broken one offers Repair', async () => {
  await renderTree();

  const healthy = openMenu('videos').map((item) => item.label);
  closeMenu();
  assert.deepEqual(healthy, ['New File', 'New Folder', 'Upload Files', 'Unmount', 'Copy Target Path', 'Refresh']);

  const broken = openMenu('archive').map((item) => item.label);
  closeMenu();
  assert.deepEqual(broken, ['Repair Mount', 'Unmount', 'Copy Target Path', 'Refresh']);
});

test('mounts/ itself is not renamed or deleted, and no folder in or above a mount is zipped', async () => {
  await renderTree();

  const mountsMenu = openMenu('mounts');
  closeMenu();
  assert.equal(mountsMenu.some((item) => item.label === 'Rename' || item.label === 'Delete'), false);
  assert.equal(mountsMenu.find((item) => item.label === 'Download')?.disabled, true);

  fireEvent.click(screen.getByText('videos'));
  await waitFor(() => assert.equal(screen.queryByText('raw') !== null, true));
  const inMountFolder = openMenu('raw');
  closeMenu();
  assert.equal(inMountFolder.some((item) => item.label === 'Rename'), true);
  assert.equal(inMountFolder.find((item) => item.label === 'Download')?.disabled, true);

  // A file in a mount still downloads on its own, and a project folder still zips.
  const inMountFile = openMenu('cut.mp4');
  closeMenu();
  assert.equal(inMountFile.find((item) => item.label === 'Download')?.disabled, false);
  const projectFolder = openMenu('src');
  closeMenu();
  assert.equal(projectFolder.find((item) => item.label === 'Download')?.disabled, false);
});

test('mounts/ itself takes no new file, folder or upload and claims no drop; it offers mounting instead', async () => {
  await renderTree();

  const mountsMenu = openMenu('mounts');
  closeMenu();
  assert.deepEqual(mountsMenu.map((item) => item.label), ['Mount Folder…', 'Copy Path', 'Download']);

  // No upload button on its row, and a file dragged over it is not aimed at it.
  assert.equal(within(rowOf('mounts')).queryByRole('button', { name: 'Upload files to "mounts"' }) === null, true);
  assert.equal(within(rowOf('src')).queryByRole('button', { name: 'Upload files to "src"' }) !== null, true);
  fireEvent.dragOver(rowOf('mounts'));
  assert.equal(rowOf('mounts').className.includes('ring-blue-500/40'), false);
  fireEvent.dragOver(rowOf('src'));
  assert.equal(rowOf('src').className.includes('ring-blue-500/40'), true);

  openMenu('mounts');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mount Folder…' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
});

test('the mounts/ menu without the mount action opens on an item, not a separator', async () => {
  const { default: FileContextMenu } = await import('@/modules/file-tree/FileContextMenu');
  render(
    <FileContextMenu item={tree[0] as FileTreeNode} holdsMounts onCopyPath={() => undefined}>
      <span>mounts row</span>
    </FileContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText('mounts row'), { clientX: 20, clientY: 20 });
  assert.deepEqual(screen.getAllByRole('menuitem').map((item) => item.textContent), ['Copy Path', 'Download']);
  assert.equal(screen.getByRole('menu').firstElementChild?.getAttribute('role'), 'menuitem');
});

test('a mount that only lost its ignore file offers Repair, as its tooltip says, and still takes new files', async () => {
  const unignored = tree.map((node) => (node.name === 'mounts'
    ? {
        ...node,
        children: node.children?.map((child) => (child.name === 'videos' && child.mount
          ? { ...child, mount: { ...child.mount, status: 'not-ignored' } }
          : child)),
      }
    : node));
  getFiles.mockResolvedValue({ ok: true, json: async () => unignored });
  await renderTree();

  assert.equal(rowOf('videos').getAttribute('title')?.includes('right-click to repair'), true);
  const labels = openMenu('videos').map((item) => item.label);
  assert.deepEqual(labels, ['Repair Mount', 'New File', 'New Folder', 'Upload Files', 'Unmount', 'Copy Target Path', 'Refresh']);

  fireEvent.click(screen.getByRole('menuitem', { name: 'Repair Mount' }));
  await waitFor(() => assert.equal(repairMount.mock.calls.length, 1));
  assert.deepEqual(repairMount.mock.calls[0], ['p1', 'm1']);
});

// mounts/ after every link in it was removed in a terminal: the registered mounts list nothing under it.
const treeWithEmptyMounts = [{ type: 'directory', name: 'mounts', path: MOUNTS, children: [] }, ...tree.slice(1)];

const REGISTERED_MOUNT = {
  mountId: 'm1',
  name: 'videos',
  linkPath: 'mounts/videos',
  targetPath: '/mnt/media/videos',
  realTargetPath: '/mnt/media/videos',
  status: 'missing-link',
  createdAt: '2026-10-30T10:00:00Z',
};

const renderEmptyMountsTree = async () => {
  getFiles.mockResolvedValue({ ok: true, json: async () => treeWithEmptyMounts });
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.equal(screen.queryByText('mounts') !== null, true));
  // The tree asks for the project's mounts itself; the dialog was never opened.
  await waitFor(() => assert.deepEqual(listMounts.mock.calls[0], ['p1']));
};

test('mounts/ stays protected when every link in it is gone, as long as the project has mounts', async () => {
  listMounts.mockImplementation(async () => json({ success: true, data: { mounts: [REGISTERED_MOUNT], adoptable: [] } }));
  await renderEmptyMountsTree();

  // Once the listing lands, the row loses its upload button. The wait only reads the DOM: a
  // callback that opened the menu would change the DOM it watches and never let it time out.
  await waitFor(() => assert.equal(within(rowOf('mounts')).queryByRole('button', { name: 'Upload files to "mounts"' }) === null, true));
  const labels = openMenu('mounts').map((item) => item.label);
  closeMenu();
  assert.deepEqual(labels, ['Mount Folder…', 'Copy Path', 'Download']);
  fireEvent.dragOver(rowOf('mounts'));
  assert.equal(rowOf('mounts').className.includes('ring-blue-500/40'), false);
});

test('a mounts folder of the user\'s own, with no mounts registered, is an ordinary folder', async () => {
  await renderEmptyMountsTree();
  await waitFor(() => assert.equal(listMounts.mock.results[0]?.type, 'return'));

  const labels = openMenu('mounts').map((item) => item.label);
  closeMenu();
  assert.deepEqual(labels, ['New File', 'New Folder', 'Upload Files', 'Rename', 'Delete', 'Copy Path', 'Download']);
});

// The server's refusal of a change to mounts/ while the project has mounts.
const mountProtected = () => json({ error: 'Mounted folders cannot be renamed or deleted here; unmount them instead', code: 'MOUNT_PROTECTED' }, 403);

test('a refused delete of mounts/ is said in the user\'s language, not the server\'s English', async () => {
  // The mounts could not be listed, so the menu still offers Delete; the server refuses it.
  listMounts.mockRejectedValue(new Error('offline'));
  deleteFile.mockImplementation(async () => mountProtected());
  await renderEmptyMountsTree();
  await i18n.changeLanguage('zh-CN');

  openMenu('mounts');
  fireEvent.click(screen.getByRole('menuitem', { name: i18n.t('fileTree.context.delete') }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('fileTree.delete.confirm') }));
  await waitFor(() => assert.equal(deleteFile.mock.calls.length, 1));
  await waitFor(() => assert.equal(screen.queryByText('mounts 文件夹和里面的挂载不能在这里重命名或删除，请改用卸载。') !== null, true));
  assert.equal(screen.queryByText(/Mounted folders cannot/) === null, true);
});

test('a refused rename of mounts/ is said in the user\'s language, not the server\'s English', async () => {
  listMounts.mockRejectedValue(new Error('offline'));
  renameFile.mockImplementation(async () => mountProtected());
  await renderEmptyMountsTree();
  await i18n.changeLanguage('zh-CN');

  openMenu('mounts');
  fireEvent.click(screen.getByRole('menuitem', { name: i18n.t('fileTree.context.rename') }));
  const input = screen.getByDisplayValue('mounts');
  fireEvent.change(input, { target: { value: 'old-mounts' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => assert.equal(renameFile.mock.calls.length > 0, true));
  await waitFor(() => assert.equal(screen.queryByText('mounts 文件夹和里面的挂载不能在这里重命名或删除，请改用卸载。') !== null, true));
  assert.equal(screen.queryByText(/Mounted folders cannot/) === null, true);
});

test('deleting a file inside a mount warns in red that the real file outside the project goes', async () => {
  await renderTree();
  fireEvent.click(screen.getByText('videos'));
  await waitFor(() => assert.equal(screen.queryByText('cut.mp4') !== null, true));

  openMenu('cut.mp4');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const warning = document.querySelector('[data-delete-warning="mount"]');
  assert.equal(warning !== null, true);
  assert.equal(warning?.textContent?.includes('/mnt/media/videos'), true);
  assert.equal(warning?.textContent?.includes('videos'), true);
  assert.equal(warning?.className.includes('text-red-600'), true);

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.equal(deleteFile.mock.calls.length, 1));
  assert.equal((deleteFile.mock.calls[0]?.[1] as { path?: string } | undefined)?.path, `${MOUNTS}/videos/cut.mp4`);
});

test('deleting a project file shows no mount warning', async () => {
  await renderTree();

  openMenu('README.md');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  assert.equal(document.querySelector('[data-delete-warning="mount"]') === null, true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
});

test('Unmount from the menu asks first, then removes the link and lists the tree again', async () => {
  await renderTree();
  const listingsBefore = getFiles.mock.calls.length;

  openMenu('videos');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Unmount' }));
  const confirmation = screen.getByText('Unmount videos?').closest('.fixed') as HTMLElement;
  assert.equal(within(confirmation).queryByText(/\/mnt\/media\/videos/) !== null, true);
  assert.equal(removeMount.mock.calls.length, 0);

  fireEvent.click(within(confirmation).getByRole('button', { name: 'Unmount' }));
  await waitFor(() => assert.equal(removeMount.mock.calls.length, 1));
  assert.deepEqual(removeMount.mock.calls[0], ['p1', 'm1']);
  await waitFor(() => assert.equal(screen.queryByText('Unmounted videos') !== null, true));
  await waitFor(() => assert.equal(getFiles.mock.calls.length > listingsBefore, true));
});

test('Repair from a broken mount\'s menu recreates its link', async () => {
  await renderTree();

  openMenu('archive');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Repair Mount' }));
  await waitFor(() => assert.equal(repairMount.mock.calls.length, 1));
  assert.deepEqual(repairMount.mock.calls[0], ['p1', 'm2']);
  await waitFor(() => assert.equal(screen.queryByText('Repaired archive') !== null, true));
});

test('Copy Target Path copies the folder the mount links to, not the link', async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  await renderTree();

  openMenu('videos');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Target Path' }));
  await waitFor(() => assert.equal(writeText.mock.calls.length, 1));
  assert.deepEqual(writeText.mock.calls[0], ['/mnt/media/videos']);
});

test('the empty area\'s menu and the header both open the mount dialog', async () => {
  await renderTree();

  // Right-clicking the scroller around the rows opens the root menu, which now offers mounting.
  const scroller = screen.getByText('README.md').closest('.overflow-auto') as HTMLElement;
  fireEvent.contextMenu(scroller, { clientX: 20, clientY: 200 });
  const rootItems = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
  assert.deepEqual(rootItems, ['New File', 'New Folder', 'Upload Files', 'Mount Folder…', 'Refresh']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mount Folder…' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));

  fireEvent.click(screen.getByRole('button', { name: 'Mount Folder…' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
});

test('a right-click inside a row\'s open menu does not open the empty area\'s menu on top of it', async () => {
  await renderTree();

  openMenu('README.md');
  // The row's menu sits inside the empty area's menu wrapper; the right-click stays with the open menu.
  const notPrevented = fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Rename' }), { clientX: 30, clientY: 30 });
  assert.equal(notPrevented, false);
  assert.equal(screen.getAllByRole('menu').length, 1);
  assert.deepEqual(screen.getAllByRole('menuitem').map((item) => item.textContent ?? ''), ['Rename', 'Delete', 'Copy Path', 'Download']);
});

test('a text box keeps the browser\'s own menu', async () => {
  await renderTree();
  fireEvent.click(screen.getByRole('button', { name: 'New File (Cmd+N)' }));
  const input = screen.getByDisplayValue('untitled.txt');
  fireEvent.contextMenu(input, { clientX: 20, clientY: 20 });
  assert.equal(screen.queryByRole('menu') === null, true);
});

test('a root .gitignore rule matching mounts/ neither greys out nor closes the mounts', async () => {
  // As the server could mark them when the project's .gitignore lists mounts/.
  const ignoredMounts = tree.map((node) => (node.name === 'mounts'
    ? { ...node, isIgnored: true, children: node.children?.map((child) => ({ ...child, isIgnored: true })) }
    : node));
  getFiles.mockResolvedValue({ ok: true, json: async () => ignoredMounts });
  await renderTree();

  assert.equal(screen.getByText('mounts').className.includes('opacity-60'), false);
  assert.equal(screen.getByText('videos').className.includes('opacity-60'), false);
  assert.equal(rowOf('videos').getAttribute('title'), 'Mounted folder → /mnt/media/videos');
  fireEvent.click(screen.getByText('videos'));
  await waitFor(() => assert.equal(screen.queryByText('cut.mp4') !== null, true));
});
