import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import NotificationsSettingsTab from '@/modules/settings/tabs/NotificationsSettingsTab';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { NotificationPreferencesState } from '@/shared/types';
import { readUserPreference, resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import { playChatCompletionSound } from '@/shared/utils';
import type * as SharedUtils from '@/shared/utils';

/**
 * The notifications page opens with a "While CloudCLI is open" card: the chime, the in-page
 * banner and the page's own system notification, all as switches. The system notification
 * needs the browser's permission, so its switch reads off and stays locked until the
 * permission is granted, with the way forward (or the reason there is none) shown beneath.
 */

// The preference store saves to the server on a debounce; keep that off the network.
vi.mock('@/shared/api', () => ({
  api: {
    user: {
      savePreferences: () => Promise.resolve({ ok: true }),
    },
  },
}));

vi.mock('@/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedUtils>()),
  playChatCompletionSound: vi.fn(async () => true),
}));

type TabProps = ComponentProps<typeof NotificationsSettingsTab>;

const notificationPreferences = (): NotificationPreferencesState => ({
  channels: { inApp: true, webPush: false, desktop: false, sound: true },
  events: { actionRequired: true, stop: true, error: true },
});

const renderTab = (overrides: Partial<TabProps> = {}) => {
  const props: TabProps = {
    notificationPreferences: notificationPreferences(),
    onNotificationPreferencesChange: vi.fn(),
    pushPermission: 'granted',
    isPushSubscribed: false,
    isPushLoading: false,
    onEnablePush: vi.fn(),
    onDisablePush: vi.fn(),
    onRequestNotificationPermission: vi.fn(async () => 'granted' as const),
    ...overrides,
  };
  render(
    <UiPreferencesProvider>
      <NotificationsSettingsTab {...props} />
    </UiPreferencesProvider>,
  );
  return props;
};

const storedUiPreferences = () => readUserPreference<Record<string, unknown>>('uiPreferences', {});

const switchNamed = (name: string) => screen.getByRole('switch', { name }) as HTMLButtonElement;

// Presence checks come back as booleans: node:assert must never be handed a DOM node,
// because a failing assertion inspects its arguments through the whole jsdom tree.
const hasText = (text: string) => screen.queryByText(text) !== null;
const hasHeading = (name: string) => screen.queryByRole('heading', { name }) !== null;
const hasSwitch = (name: string) => screen.queryByRole('switch', { name }) !== null;
const hasButton = (name: string) => screen.queryByRole('button', { name }) !== null;

/** True when `first` comes before `second` in document order. */
const precedes = (first: Element, second: Element) => Boolean(
  first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
);

const SYSTEM_NOTIFICATION = 'System notification';
const ALLOW_NOTIFICATIONS = 'Allow notifications';
const DENIED_NOTE = 'Notifications are blocked for this site. Allow them in the browser site settings.';
const UNSUPPORTED_NOTE = 'Not available here. System notifications need HTTPS or localhost.';
const VIA_PUSH_NOTE = 'Push notifications are on for this browser, so they deliver these instead.';

beforeEach(() => {
  localStorage.clear();
  // The store keeps an in-memory copy that outlives localStorage.clear().
  resetUserPreferences();
  vi.mocked(playChatCompletionSound).mockClear();
});

afterEach(async () => {
  // Unmount before switching the language back, so the switch does not re-render a live tree.
  cleanup();
  await i18n.changeLanguage('en');
  resetUserPreferences();
});

test('the page opens with the While CloudCLI is open card and its three switches', () => {
  renderTab();

  const cardHeading = screen.getByRole('heading', { name: 'While CloudCLI is open' });
  const webPushHeading = screen.getByRole('heading', { name: 'Notify this browser' });
  assert.equal(precedes(cardHeading, webPushHeading), true, 'the card comes before the push card');
  assert.equal(hasText('How this browser tells you a task has finished while a CloudCLI tab is open.'), true);

  for (const name of ['Sound', 'Banner', SYSTEM_NOTIFICATION]) {
    const toggle = switchNamed(name);
    assert.equal(precedes(cardHeading, toggle) && precedes(toggle, webPushHeading), true, `${name} sits in the card`);
  }
  assert.equal(hasText('Play a short tone when a task finishes or needs tool approval.'), true);
  assert.equal(hasText('Show a banner when a task finishes, with a button to open its conversation.'), true);
  assert.equal(hasText('Show a system notification when a task finishes and no CloudCLI tab is in front.'), true);
  // The old sound checkbox moved into the card as a switch.
  assert.equal(screen.queryByRole('checkbox', { name: 'Enabled' }) === null, true);
});

test('the sound switch saves channels.sound through the notification preferences', () => {
  const props = renderTab();
  assert.equal(switchNamed('Sound').getAttribute('aria-checked'), 'true');

  fireEvent.click(switchNamed('Sound'));

  assert.deepEqual(vi.mocked(props.onNotificationPreferencesChange).mock.calls, [[{
    channels: { inApp: true, webPush: false, desktop: false, sound: false },
    events: { actionRequired: true, stop: true, error: true },
  }]]);
});

test('the sound row keeps its Test sound button', () => {
  renderTab({ notificationPreferences: { ...notificationPreferences(), channels: { ...notificationPreferences().channels, sound: false } } });
  assert.equal(switchNamed('Sound').getAttribute('aria-checked'), 'false');

  fireEvent.click(screen.getByRole('button', { name: 'Test sound' }));

  // Forced, so the preview plays while the sound is off.
  assert.deepEqual(vi.mocked(playChatCompletionSound).mock.calls, [[{ force: true }]]);
});

test('the banner switch writes runAlertBanner', () => {
  renderTab();
  assert.equal(switchNamed('Banner').getAttribute('aria-checked'), 'true');

  fireEvent.click(switchNamed('Banner'));

  assert.equal(switchNamed('Banner').getAttribute('aria-checked'), 'false');
  assert.equal(storedUiPreferences().runAlertBanner, false);
});

test('before permission is asked, the system switch is off and locked, and Allow notifications asks for it', () => {
  const props = renderTab({ pushPermission: 'default' });

  const toggle = switchNamed(SYSTEM_NOTIFICATION);
  assert.equal(toggle.getAttribute('aria-checked'), 'false', 'off even though the preference is on');
  assert.equal(toggle.disabled, true);
  for (const note of [DENIED_NOTE, UNSUPPORTED_NOTE, VIA_PUSH_NOTE]) {
    assert.equal(hasText(note), false, note);
  }

  fireEvent.click(screen.getByRole('button', { name: ALLOW_NOTIFICATIONS }));

  // Checked straight after the click: the request has to be the click's first async step.
  assert.equal(vi.mocked(props.onRequestNotificationPermission).mock.calls.length, 1);
});

test('blocked notifications lock the system switch and say where to allow them', () => {
  renderTab({ pushPermission: 'denied' });

  const toggle = switchNamed(SYSTEM_NOTIFICATION);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(toggle.disabled, true);
  assert.equal(hasText(DENIED_NOTE), true);
  assert.equal(hasButton(ALLOW_NOTIFICATIONS), false);
});

test('without notification support the system switch is locked and explained', () => {
  renderTab({ pushPermission: 'unsupported' });

  const toggle = switchNamed(SYSTEM_NOTIFICATION);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(toggle.disabled, true);
  assert.equal(hasText(UNSUPPORTED_NOTE), true);
  assert.equal(hasButton(ALLOW_NOTIFICATIONS), false);
});

test('once permission is granted the system switch follows and writes runAlertSystemNotification', () => {
  renderTab({ pushPermission: 'granted' });

  const toggle = switchNamed(SYSTEM_NOTIFICATION);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(toggle.disabled, false);
  assert.equal(hasButton(ALLOW_NOTIFICATIONS), false);
  for (const note of [DENIED_NOTE, UNSUPPORTED_NOTE, VIA_PUSH_NOTE]) {
    assert.equal(hasText(note), false, note);
  }

  fireEvent.click(toggle);

  assert.equal(switchNamed(SYSTEM_NOTIFICATION).getAttribute('aria-checked'), 'false');
  assert.equal(storedUiPreferences().runAlertSystemNotification, false);
});

test('a granted permission with the preference off shows the switch off but usable', () => {
  writeUserPreference('uiPreferences', { runAlertSystemNotification: false });
  renderTab({ pushPermission: 'granted' });

  const toggle = switchNamed(SYSTEM_NOTIFICATION);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(toggle.disabled, false);
});

test('with push on for this browser, the system row says push delivers them instead', () => {
  renderTab({ pushPermission: 'granted', isPushSubscribed: true });

  assert.equal(hasText(VIA_PUSH_NOTE), true);
  // The preference still shows and can still be changed.
  const toggle = switchNamed(SYSTEM_NOTIFICATION);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(toggle.disabled, false);
});

test('the desktop app shows no system notification row', () => {
  renderTab({ isDesktop: true, pushPermission: 'unsupported' });

  assert.equal(hasSwitch(SYSTEM_NOTIFICATION), false);
  assert.equal(hasText(UNSUPPORTED_NOTE), false);
  assert.equal(hasButton(ALLOW_NOTIFICATIONS), false);
  assert.equal(hasSwitch('Sound'), true);
  assert.equal(hasSwitch('Banner'), true);
});

test('the push card explains itself and the events card is named for push and desktop', () => {
  renderTab();

  assert.equal(hasText(
    'Reaches this browser even when CloudCLI is closed. While a CloudCLI tab is in front, task notifications arrive without sound.',
  ), true);
  assert.equal(hasHeading('Push and desktop notification events'), true);
});

test('in Chinese the card, its rows and the renamed cards read correctly', async () => {
  await i18n.changeLanguage('zh-CN');
  renderTab({ pushPermission: 'default' });

  assert.equal(hasHeading('页面打开时'), true);
  assert.equal(hasText('浏览器里开着 CloudCLI 时，任务完成后怎么提醒你。'), true);
  assert.equal(hasSwitch('声音'), true);
  assert.equal(hasText('任务完成或需要批准工具时播放短提示音。'), true);
  assert.equal(hasSwitch('提示条'), true);
  assert.equal(hasText('任务完成时在页面上显示提示条，可从提示条打开会话。'), true);
  assert.equal(hasSwitch('系统通知'), true);
  assert.equal(hasText('任务完成且 CloudCLI 不在前台时弹出系统通知。'), true);
  assert.equal(hasButton('允许通知'), true);
  assert.equal(hasText('即使没打开 CloudCLI 也能收到。CloudCLI 在前台时，任务通知不响铃。'), true);
  assert.equal(hasHeading('推送和桌面通知的事件'), true);
});

test('in Chinese each permission note reads correctly', async () => {
  await i18n.changeLanguage('zh-CN');

  const notes: Array<[TabProps['pushPermission'], boolean, string]> = [
    ['denied', false, '此网站的通知已被阻止，请在浏览器的网站设置中允许。'],
    ['unsupported', false, '当前不可用，系统通知需要 HTTPS 或 localhost。'],
    ['granted', true, '此浏览器已开启推送，系统通知改由推送发送。'],
  ];
  for (const [pushPermission, isPushSubscribed, note] of notes) {
    renderTab({ pushPermission, isPushSubscribed });
    assert.equal(hasText(note), true, pushPermission);
    cleanup();
  }
});
