import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * The mount dialog, opened from the Files tab's header. It lists the project's mounts with their
 * state, checks the form before sending it, says the server's refusals in the user's language,
 * repairs, unmounts (after a second click) and registers stray links, and picks the target with the
 * folder browser over the mount browse endpoint.
 */

const ROOT = '/home/u/demo';

const MOUNTS = [
  {
    mountId: 'm1',
    name: 'videos',
    linkPath: 'mounts/videos',
    targetPath: '/mnt/media/videos',
    realTargetPath: '/mnt/media/videos',
    status: 'ok',
    createdAt: '2026-10-30T10:00:00Z',
  },
  {
    mountId: 'm2',
    name: 'archive',
    linkPath: 'mounts/archive',
    targetPath: '/mnt/old/archive',
    realTargetPath: null,
    status: 'missing-link',
    createdAt: '2026-10-30T10:00:00Z',
  },
];

const { getFiles, listMounts, createMount, removeMount, repairMount, adoptMount, browseMounts } = vi.hoisted(() => ({
  getFiles: vi.fn(),
  listMounts: vi.fn(),
  createMount: vi.fn(),
  removeMount: vi.fn(),
  repairMount: vi.fn(),
  adoptMount: vi.fn(),
  browseMounts: vi.fn(),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusal = (code: string, status = 400) => json({ success: false, error: { code, message: `server says ${code}` } }, status);
// A refusal carrying the system's reason in `details`, as the server sends MOUNT_LINK_FAILED.
const refusalWithReason = (code: string, status: number, reason: string) =>
  json({ success: false, error: { code, message: `server says ${code}`, details: reason } }, status);

// An answer the test sends when it chooses, for a request still out while the user acts.
const heldAnswer = () => {
  let send: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    send = resolve;
  });
  return { promise, send };
};

const FORBIDDEN_TEXT = "System folders, private folders such as ~/.ssh, and folders that contain them can't be mounted. For your home folder, pick a folder inside it.";

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      getFiles: (...args: unknown[]) => getFiles(...args),
      uploadFilesUrl: (projectId: string) => `/api/file-tree/projects/${projectId}/files/upload`,
      mounts: {
        list: (...args: unknown[]) => listMounts(...args),
        create: (...args: unknown[]) => createMount(...args),
        remove: (...args: unknown[]) => removeMount(...args),
        repair: (...args: unknown[]) => repairMount(...args),
        adopt: (...args: unknown[]) => adoptMount(...args),
        browse: (...args: unknown[]) => browseMounts(...args),
      },
    },
  };
});

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'demo', fullPath: ROOT, path: ROOT };

const openDialog = async () => {
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.equal(screen.queryByText('README.md') !== null, true));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('fileTree.mounts.open') }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
  return screen.getByRole('dialog');
};

const rowOf = (dialog: HTMLElement, name: string) => dialog.querySelector(`[data-mount-row="${name}"]`) as HTMLElement;

const fillForm = (dialog: HTMLElement, { target, name }: { target?: string; name?: string }) => {
  if (target !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('Folder to mount'), { target: { value: target } });
  }
  if (name !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: name } });
  }
};

const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Mount' }));

const alertText = (dialog: HTMLElement) => within(dialog).queryByRole('alert')?.textContent ?? null;

beforeEach(() => {
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: true, json: async () => [{ type: 'file', name: 'README.md', path: `${ROOT}/README.md` }] });
  listMounts.mockReset();
  listMounts.mockImplementation(async () => json({ success: true, data: { mounts: MOUNTS, adoptable: [{ name: 'datasets', targetPath: '/data/sets' }] } }));
  createMount.mockReset();
  createMount.mockImplementation(async () => json({ success: true, data: { mount: MOUNTS[0] } }));
  removeMount.mockReset();
  removeMount.mockImplementation(async () => json({ success: true, data: { removed: true, linkRemoved: false } }));
  repairMount.mockReset();
  repairMount.mockImplementation(async () => json({ success: true, data: { mount: MOUNTS[1] } }));
  adoptMount.mockReset();
  adoptMount.mockImplementation(async () => json({ success: true, data: { mount: MOUNTS[0] } }));
  browseMounts.mockReset();
  browseMounts.mockImplementation(async (folderPath: string | null) => json({
    success: true,
    data: folderPath === '/mnt/media'
      ? { path: '/mnt/media', parent: '/mnt', directories: [{ name: 'Big Clips', path: '/mnt/media/Big Clips' }] }
      : { path: '/home/u', parent: '/home', directories: [{ name: 'media', path: '/mnt/media' }] },
  }));
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

test('the dialog lists the mounts with their state and offers Repair only where something is wrong', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(rowOf(dialog, 'videos') !== null, true));
  assert.deepEqual(listMounts.mock.calls[0], ['p1']);

  const healthy = rowOf(dialog, 'videos');
  assert.equal(healthy.textContent?.includes('/mnt/media/videos'), true);
  assert.equal(healthy.textContent?.includes('Linked'), true);
  assert.equal(within(healthy).queryByRole('button', { name: 'Repair' }) === null, true);

  const broken = rowOf(dialog, 'archive');
  assert.equal(broken.textContent?.includes('Link missing'), true);
  assert.equal(within(broken).queryByRole('button', { name: 'Repair' }) !== null, true);

  // The unregistered link is offered for registration.
  assert.equal(within(dialog).queryByText('datasets') !== null, true);
  // The dialog says which agents use mounts fully.
  assert.equal(dialog.textContent?.includes('Claude and Codex'), true);
});

test('the form is checked before it is sent', async () => {
  const dialog = await openDialog();

  submit(dialog);
  assert.equal(alertText(dialog), 'Enter a name.');

  fillForm(dialog, { name: 'a/b', target: '/mnt/media' });
  submit(dialog);
  assert.equal(alertText(dialog), "The name can't contain slashes or special characters, or be only dots.");

  fillForm(dialog, { name: '..' });
  submit(dialog);
  assert.equal(alertText(dialog), "The name can't contain slashes or special characters, or be only dots.");

  fillForm(dialog, { name: 'media', target: '' });
  submit(dialog);
  assert.equal(alertText(dialog), 'Choose the folder to mount.');

  fillForm(dialog, { target: 'mnt/media' });
  submit(dialog);
  assert.equal(alertText(dialog), "Enter the folder's full path.");

  assert.equal(createMount.mock.calls.length, 0);
});

test('a valid form mounts the folder, then lists the mounts and the tree again', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(listMounts.mock.calls.length, 1));
  const listingsBefore = getFiles.mock.calls.length;

  fillForm(dialog, { target: ' /mnt/media ', name: ' media ' });
  submit(dialog);
  await waitFor(() => assert.equal(createMount.mock.calls.length, 1));
  assert.deepEqual(createMount.mock.calls[0], ['p1', { name: 'media', targetPath: '/mnt/media' }]);

  await waitFor(() => assert.equal(listMounts.mock.calls.length, 2));
  await waitFor(() => assert.equal(getFiles.mock.calls.length > listingsBefore, true));
  assert.equal(screen.queryByText('Mounted media') !== null, true);
  // The form is cleared for the next mount.
  assert.equal((within(dialog).getByLabelText('Name') as HTMLInputElement).value, '');
  assert.equal(alertText(dialog), null);
});

test('the server\'s refusals are said in the user\'s words; an unknown one keeps the server\'s message', async () => {
  const dialog = await openDialog();
  fillForm(dialog, { target: '/etc', name: 'etc' });

  createMount.mockImplementationOnce(async () => refusal('MOUNT_TARGET_FORBIDDEN'));
  submit(dialog);
  // The home folder the browser opens at is refused too, for the private folders it contains: the copy says so.
  await waitFor(() => assert.equal(alertText(dialog), FORBIDDEN_TEXT));

  fillForm(dialog, { name: 'videos' });
  createMount.mockImplementationOnce(async () => refusal('MOUNT_NAME_TAKEN', 409));
  submit(dialog);
  await waitFor(() => assert.equal(alertText(dialog), 'A mount with that name already exists.'));

  createMount.mockImplementationOnce(async () => refusal('SOMETHING_NEW', 500));
  submit(dialog);
  await waitFor(() => assert.equal(alertText(dialog), 'server says SOMETHING_NEW'));
});

test('a name refused because something else sits at mounts/<name> is not said to be a mount of that name', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(rowOf(dialog, 'videos') !== null, true));
  fillForm(dialog, { target: '/data/sets' });

  // A link listed under "Links not registered yet".
  fillForm(dialog, { name: 'datasets' });
  createMount.mockImplementationOnce(async () => refusal('MOUNT_NAME_TAKEN', 409));
  submit(dialog);
  await waitFor(() => assert.equal(alertText(dialog), "mounts/datasets is a link that isn't registered yet. Register it below, or pick another name."));

  // A stray file or folder, listed nowhere.
  fillForm(dialog, { name: 'stray' });
  createMount.mockImplementationOnce(async () => refusal('MOUNT_NAME_TAKEN', 409));
  submit(dialog);
  await waitFor(() => assert.equal(
    alertText(dialog),
    "mounts/stray already holds a file, folder or link that isn't a mount. Move it out of the way, or pick another name.",
  ));

  await i18n.changeLanguage('zh-CN');
  createMount.mockImplementationOnce(async () => refusal('MOUNT_NAME_TAKEN', 409));
  fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('fileTree.mounts.submit') }));
  await waitFor(() => assert.equal(alertText(dialog)?.startsWith('mounts/stray 那里已经有'), true));
});

test('what Repair, Unmount, Register and Mount came to is said in the dialog, not in a toast under its overlay', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(rowOf(dialog, 'archive') !== null, true));
  // Only the dialog's own text counts: the tree's toast sits under the dialog's overlay.
  const dialogSays = (text: string) => dialog.textContent?.includes(text) === true;

  repairMount.mockImplementationOnce(async () => refusal('MOUNT_TARGET_NOT_FOUND'));
  fireEvent.click(within(rowOf(dialog, 'archive')).getByRole('button', { name: 'Repair' }));
  await waitFor(() => assert.equal(alertText(dialog), "That folder doesn't exist or doesn't answer (an offline network share?)."));

  fireEvent.click(within(rowOf(dialog, 'videos')).getByRole('button', { name: 'Unmount' }));
  fireEvent.click(within(rowOf(dialog, 'videos')).getByRole('button', { name: 'Unmount' }));
  await waitFor(() => assert.equal(dialogSays('videos is no longer registered. No link made by this app was at mounts/videos, so nothing there was touched.'), true));
  // The next action's outcome replaces the last one.
  assert.equal(alertText(dialog), null);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Register' }));
  await waitFor(() => assert.equal(dialogSays('Registered datasets'), true));

  fillForm(dialog, { target: '/mnt/media', name: 'media' });
  submit(dialog);
  await waitFor(() => assert.equal(dialogSays('Mounted media'), true));
  assert.equal(dialogSays('Registered datasets'), false);

  // Closing the dialog clears it; the next opening starts without it.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('fileTree.mounts.open') }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
  assert.equal(screen.getByRole('dialog').textContent?.includes('Mounted media'), false);
});

test('Repair, Unmount after confirming, and Register act on the right mount', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(rowOf(dialog, 'archive') !== null, true));

  fireEvent.click(within(rowOf(dialog, 'archive')).getByRole('button', { name: 'Repair' }));
  await waitFor(() => assert.equal(repairMount.mock.calls.length, 1));
  assert.deepEqual(repairMount.mock.calls[0], ['p1', 'm2']);

  // The first click only asks; the files are said to stay.
  fireEvent.click(within(rowOf(dialog, 'videos')).getByRole('button', { name: 'Unmount' }));
  assert.equal(removeMount.mock.calls.length, 0);
  assert.equal(rowOf(dialog, 'videos').textContent?.includes('stay where they are'), true);
  fireEvent.click(within(rowOf(dialog, 'videos')).getByRole('button', { name: 'Unmount' }));
  await waitFor(() => assert.equal(removeMount.mock.calls.length, 1));
  assert.deepEqual(removeMount.mock.calls[0], ['p1', 'm1']);
  // The spot was not the app's link: only the registration went, and the notice says so.
  await waitFor(() => assert.equal(screen.queryByText(/No link made by this app was at mounts\/videos/) !== null, true));

  fireEvent.click(within(dialog).getByRole('button', { name: 'Register' }));
  await waitFor(() => assert.equal(adoptMount.mock.calls.length, 1));
  assert.deepEqual(adoptMount.mock.calls[0], ['p1', 'datasets']);
});

test('a mount action on a tree that failed to load leaves the dialog open as it was while the tree loads again', async () => {
  // The tree was refused, and the reload the action starts stays out until the test answers it.
  const reload = heldAnswer();
  getFiles.mockResolvedValueOnce(json({ error: 'This project has too many files to list.' }, 413));
  getFiles.mockImplementationOnce(() => reload.promise);
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.equal(screen.queryByText('This project has too many files to list.') !== null, true));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('fileTree.mounts.open') }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
  const dialog = screen.getByRole('dialog');
  await waitFor(() => assert.equal(rowOf(dialog, 'archive') !== null, true));
  const stillAsItWas = () => screen.queryByRole('dialog') === dialog
    && rowOf(dialog, 'videos')?.textContent?.includes('stay where they are') === true;

  // One row's Unmount waits for its second click while another row is repaired.
  fireEvent.click(within(rowOf(dialog, 'videos')).getByRole('button', { name: 'Unmount' }));
  fireEvent.click(within(rowOf(dialog, 'archive')).getByRole('button', { name: 'Repair' }));
  await waitFor(() => assert.equal(getFiles.mock.calls.length, 2));
  // Nothing was on screen to keep, so the reload shows the loading state; the dialog stays over it.
  await waitFor(() => assert.equal(screen.queryByText(i18n.t('fileTree.loading')) !== null, true));
  assert.equal(stillAsItWas(), true);

  reload.send(json([{ type: 'file', name: 'README.md', path: `${ROOT}/README.md` }]));
  await waitFor(() => assert.equal(screen.queryByText('README.md') !== null, true));
  assert.equal(stillAsItWas(), true);
});

test('a Repair refused because a real file or folder now sits at the link says so, not that the name is taken', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(rowOf(dialog, 'archive') !== null, true));
  repairMount.mockImplementationOnce(async () => refusal('MOUNT_NAME_TAKEN', 409));

  fireEvent.click(within(rowOf(dialog, 'archive')).getByRole('button', { name: 'Repair' }));
  await waitFor(() => assert.equal(
    screen.queryByText('mounts/archive is now a real file or folder, not the link. Move it out of the way and repair again, or unmount.') !== null,
    true,
  ));
  assert.equal(screen.queryByText('A mount with that name already exists.') === null, true);
});

test('a link that cannot be created or removed says which, with the system\'s reason and no Windows-only advice', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(rowOf(dialog, 'videos') !== null, true));

  createMount.mockImplementationOnce(async () => refusalWithReason('MOUNT_LINK_FAILED', 500, 'EROFS: read-only file system'));
  fillForm(dialog, { target: '/mnt/media', name: 'media' });
  submit(dialog);
  await waitFor(() => assert.equal(alertText(dialog), "The link couldn't be created: EROFS: read-only file system"));

  removeMount.mockImplementationOnce(async () => refusalWithReason('MOUNT_LINK_FAILED', 500, 'EACCES: permission denied'));
  fireEvent.click(within(rowOf(dialog, 'videos')).getByRole('button', { name: 'Unmount' }));
  fireEvent.click(within(rowOf(dialog, 'videos')).getByRole('button', { name: 'Unmount' }));
  await waitFor(() => assert.equal(removeMount.mock.calls.length, 1));
  await waitFor(() => assert.equal(screen.queryByText("The link couldn't be removed: EACCES: permission denied") !== null, true));
  assert.equal(screen.queryByText(/Developer Mode/) === null, true);
});

test('unmounting a mount whose link was already gone does not say something was left at its place', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(rowOf(dialog, 'archive') !== null, true));
  const dialogSays = (text: string) => dialog.textContent?.includes(text) === true;

  // archive is listed with its link missing (`git clean -fdx` removed mounts/, say), so the server
  // finds nothing of its own to remove there: a plain unmount.
  fireEvent.click(within(rowOf(dialog, 'archive')).getByRole('button', { name: 'Unmount' }));
  fireEvent.click(within(rowOf(dialog, 'archive')).getByRole('button', { name: 'Unmount' }));
  await waitFor(() => assert.equal(removeMount.mock.calls.length, 1));
  assert.deepEqual(removeMount.mock.calls[0], ['p1', 'm2']);
  await waitFor(() => assert.equal(dialogSays('Unmounted archive'), true));
  assert.equal(dialogSays('no longer registered'), false);

  await i18n.changeLanguage('zh-CN');
  fireEvent.click(within(rowOf(dialog, 'archive')).getByRole('button', { name: '卸载' }));
  fireEvent.click(within(rowOf(dialog, 'archive')).getByRole('button', { name: '卸载' }));
  await waitFor(() => assert.equal(removeMount.mock.calls.length, 2));
  await waitFor(() => assert.equal(dialogSays('已卸载 archive'), true));
  assert.equal(dialogSays('没有动它'), false);
});

test('a row action leaves another row\'s running action busy, and clears only its own row when done', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(rowOf(dialog, 'archive') !== null, true));
  const buttonOf = (row: string, name: string) => within(rowOf(dialog, row)).getByRole('button', { name }) as HTMLButtonElement;
  // A repair waiting on a slow share, and an unmount of another row sent meanwhile.
  const repair = heldAnswer();
  const removal = heldAnswer();
  repairMount.mockImplementationOnce(() => repair.promise);
  removeMount.mockImplementationOnce(() => removal.promise);

  fireEvent.click(buttonOf('archive', 'Repair'));
  await waitFor(() => assert.equal(buttonOf('archive', 'Repair').disabled, true));
  fireEvent.click(buttonOf('videos', 'Unmount'));
  fireEvent.click(buttonOf('videos', 'Unmount'));
  await waitFor(() => assert.equal(removeMount.mock.calls.length, 1));
  assert.equal(buttonOf('videos', 'Unmount').disabled, true);
  // Starting the unmount does not free the row still being repaired.
  assert.equal(buttonOf('archive', 'Repair').disabled, true);
  assert.equal(buttonOf('archive', 'Unmount').disabled, true);

  // The repair finishing frees its own row only, so the unmount cannot be sent twice.
  repair.send(json({ success: true, data: { mount: MOUNTS[1] } }));
  await waitFor(() => assert.equal(buttonOf('archive', 'Repair').disabled, false));
  assert.equal(buttonOf('videos', 'Unmount').disabled, true);

  removal.send(json({ success: true, data: { removed: true, linkRemoved: true } }));
  await waitFor(() => assert.equal(buttonOf('videos', 'Unmount').disabled, false));
  assert.equal(removeMount.mock.calls.length, 1);
});

test('an action on a mount removed elsewhere meanwhile says so in the user\'s language', async () => {
  const dialog = await openDialog();
  await waitFor(() => assert.equal(rowOf(dialog, 'videos') !== null, true));
  removeMount.mockImplementationOnce(async () => refusal('MOUNT_NOT_FOUND', 404));

  fireEvent.click(within(rowOf(dialog, 'videos')).getByRole('button', { name: 'Unmount' }));
  fireEvent.click(within(rowOf(dialog, 'videos')).getByRole('button', { name: 'Unmount' }));
  await waitFor(() => assert.equal(alertText(dialog), 'videos was already removed.'));
  assert.equal(screen.queryByText('server says MOUNT_NOT_FOUND') === null, true);
});

test('a mount refused after the dialog was closed is said in a toast and leaves no error for the next opening', async () => {
  const dialog = await openDialog();
  const answer = heldAnswer();
  createMount.mockImplementationOnce(() => answer.promise);
  fillForm(dialog, { target: '/etc', name: 'etc' });
  submit(dialog);
  await waitFor(() => assert.equal(createMount.mock.calls.length, 1));

  // Closed while the server still checks the folder.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));
  answer.send(refusal('MOUNT_TARGET_FORBIDDEN'));
  await waitFor(() => assert.equal(screen.queryByText(FORBIDDEN_TEXT) !== null, true));

  fireEvent.click(screen.getByRole('button', { name: i18n.t('fileTree.mounts.open') }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
  const reopened = screen.getByRole('dialog');
  assert.equal(alertText(reopened), null);
  assert.equal((within(reopened).getByLabelText('Name') as HTMLInputElement).value, '');
});

test('a mount refused after the dialog was closed and opened again is said as an outcome, not under the new form', async () => {
  const dialog = await openDialog();
  const answer = heldAnswer();
  createMount.mockImplementationOnce(() => answer.promise);
  fillForm(dialog, { target: '/etc', name: 'etc' });
  submit(dialog);
  await waitFor(() => assert.equal(createMount.mock.calls.length, 1));

  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('fileTree.mounts.open') }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
  const reopened = screen.getByRole('dialog');

  answer.send(refusal('MOUNT_TARGET_FORBIDDEN'));
  await waitFor(() => assert.equal(alertText(reopened), FORBIDDEN_TEXT));
  // The blank form of this opening was never sent, so nothing under it is red.
  assert.equal(reopened.querySelector('form [role="alert"]') === null, true);
});

test('a folder the browser cannot open is not said to be missing', async () => {
  // The server answers MOUNT_TARGET_NOT_FOUND for a folder that is gone, one it cannot read, and one that does not answer.
  browseMounts.mockImplementation(async (folderPath: string | null) => (folderPath === '/mnt/media'
    ? refusal('MOUNT_TARGET_NOT_FOUND')
    : json({ success: true, data: { path: '/home/u', parent: '/home', directories: [{ name: 'media', path: '/mnt/media' }] } })));
  const dialog = await openDialog();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
  await waitFor(() => assert.equal(screen.queryByText('media') !== null, true));
  fireEvent.click(screen.getByText('media'));
  await waitFor(() => assert.equal(
    screen.queryByText("This folder can't be opened: it doesn't exist, doesn't answer (an offline network share?), or you aren't allowed to read it.") !== null,
    true,
  ));
  assert.equal(screen.queryByText(/That folder doesn't exist/) === null, true);
});

test('a folder whose share is busy with another read is said to be busy, not missing', async () => {
  const BUSY_TEXT = "That folder couldn't be checked in time: its network share is busy (reading a large folder, say), or offline shares are holding up the checks. Try again in a moment.";
  const dialog = await openDialog();
  createMount.mockImplementationOnce(async () => refusal('MOUNT_TARGET_BUSY'));
  fillForm(dialog, { target: '/mnt/nas', name: 'nas' });
  submit(dialog);
  await waitFor(() => assert.equal(alertText(dialog), BUSY_TEXT));

  browseMounts.mockImplementation(async (folderPath: string | null) => (folderPath === '/mnt/nas/small'
    ? refusal('MOUNT_TARGET_BUSY')
    : json({ success: true, data: { path: '/mnt/nas', parent: '/mnt', directories: [{ name: 'small', path: '/mnt/nas/small' }] } })));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
  await waitFor(() => assert.equal(screen.queryByText('small') !== null, true));
  assert.equal(screen.queryByText(BUSY_TEXT) === null, true);
  fireEvent.click(screen.getByText('small'));
  await waitFor(() => assert.equal(screen.queryByText(BUSY_TEXT) !== null, true));
  assert.equal(screen.queryByText(/can't be opened/) === null, true);
});

test('a folder on a share that does not answer is not said to be missing', async () => {
  const dialog = await openDialog();
  // How the server refuses a target whose probe timed out.
  createMount.mockImplementationOnce(async () => json({
    success: false,
    error: { code: 'MOUNT_TARGET_NOT_FOUND', message: 'Folder does not answer (an offline network share?): /mnt/nas' },
  }, 400));
  fillForm(dialog, { target: '/mnt/nas', name: 'nas' });
  submit(dialog);
  await waitFor(() => assert.equal(alertText(dialog), "That folder doesn't exist or doesn't answer (an offline network share?)."));

  await i18n.changeLanguage('zh-CN');
  createMount.mockImplementationOnce(async () => refusal('MOUNT_TARGET_NOT_FOUND'));
  fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('fileTree.mounts.submit') }));
  await waitFor(() => assert.equal(alertText(dialog)?.includes('没有响应'), true));
});

test('the folder browser lists folders under the mount rules and names the mount after the pick', async () => {
  const dialog = await openDialog();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
  await waitFor(() => assert.equal(screen.queryByText('media') !== null, true));
  // No folder typed yet: the endpoint's default folder, the home folder.
  assert.equal(browseMounts.mock.calls[0][0], null);
  // The mount browse endpoint has no folder creation.
  assert.equal(screen.queryByTitle('Create new folder') === null, true);

  fireEvent.click(screen.getByText('media'));
  await waitFor(() => assert.equal(screen.queryByText('Big Clips') !== null, true));
  assert.equal(browseMounts.mock.calls[1][0], '/mnt/media');

  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
  const reopened = screen.getByRole('dialog');
  assert.equal((within(reopened).getByLabelText('Folder to mount') as HTMLInputElement).value, '/mnt/media/Big Clips');
  assert.equal((within(reopened).getByLabelText('Name') as HTMLInputElement).value, 'Big Clips');
});

test('opening another folder before a listing came back aborts it, and its late answer never replaces the newer listing', async () => {
  const slowMedia = heldAnswer();
  browseMounts.mockImplementation(async (folderPath: string | null) => {
    if (folderPath === '/mnt/media') {
      return slowMedia.promise;
    }
    if (folderPath === '/mnt/archive') {
      return json({ success: true, data: { path: '/mnt/archive', parent: '/mnt', directories: [{ name: 'Old Reels', path: '/mnt/archive/Old Reels' }] } });
    }
    return json({
      success: true,
      data: { path: '/home/u', parent: '/home', directories: [{ name: 'media', path: '/mnt/media' }, { name: 'archive', path: '/mnt/archive' }] },
    });
  });
  const dialog = await openDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
  await waitFor(() => assert.equal(screen.queryByText('media') !== null, true));

  // The folder shown stays usable while a slow one loads.
  fireEvent.click(screen.getByText('media'));
  await waitFor(() => assert.equal(browseMounts.mock.calls.length, 2));
  fireEvent.click(screen.getByText('archive'));
  await waitFor(() => assert.equal(screen.queryByText('Old Reels') !== null, true));
  assert.equal((browseMounts.mock.calls[1][1] as AbortSignal).aborted, true);
  assert.equal((browseMounts.mock.calls[2][1] as AbortSignal).aborted, false);

  slowMedia.send(json({ success: true, data: { path: '/mnt/media', parent: '/mnt', directories: [{ name: 'Big Clips', path: '/mnt/media/Big Clips' }] } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByText('Big Clips') === null, true);
  assert.equal(screen.queryByText('Old Reels') !== null, true);
});

test('a listing cut short on a slow share says so, and that the path can still be typed', async () => {
  browseMounts.mockImplementation(async () => json({
    success: true,
    data: {
      path: '/mnt/nas',
      parent: '/mnt',
      directories: [{ name: 'scans', path: '/mnt/nas/scans' }],
      truncated: { checked: 1200, total: 48000 },
    },
  }));
  const dialog = await openDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
  await waitFor(() => assert.equal(screen.queryByText('scans') !== null, true));
  assert.equal(
    screen.queryByText('Not every folder is listed: this folder is large or slow to read, and 1200 of its 48000 items were checked in time. You can still type the path in "Folder to mount".') !== null,
    true,
  );

  await i18n.changeLanguage('zh-CN');
  fireEvent.click(screen.getByText('..'));
  await waitFor(() => assert.equal(screen.queryByText(/限时内只检查了 48000 项中的 1200 项/) !== null, true));
});

test('a name the user typed is kept when a folder is picked', async () => {
  const dialog = await openDialog();
  fillForm(dialog, { name: 'clips' });

  fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
  await waitFor(() => assert.equal(screen.queryByText('media') !== null, true));
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
  assert.equal((within(screen.getByRole('dialog')).getByLabelText('Name') as HTMLInputElement).value, 'clips');
});

test('the dialog speaks Chinese and Hebrew', async () => {
  await i18n.changeLanguage('zh-CN');
  let dialog = await openDialog();
  assert.equal(dialog.textContent?.includes('挂载文件夹'), true);
  // "存放大文件" (to keep large files), never "放大文件", which reads as "enlarge files".
  assert.equal(dialog.textContent?.includes('适合存放大文件'), true);
  await waitFor(() => assert.equal(rowOf(dialog, 'archive')?.textContent?.includes('链接不见了'), true));
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));

  await i18n.changeLanguage('he');
  fireEvent.click(screen.getByRole('button', { name: i18n.t('fileTree.mounts.open') }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog') !== null, true));
  dialog = screen.getByRole('dialog');
  assert.equal(dialog.textContent?.includes('קישור תיקייה'), true);
});
