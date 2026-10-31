import assert from 'node:assert/strict';
import test from 'node:test';

import { createClientDiagnosticsService } from '../client-diagnostics.service.js';

const REPORT = {
  event: 'fullscreen',
  source: 'workspace',
  outcome: 'inWindow',
  kind: 'partial',
  elapsedMs: 3004,
  displayModeBefore: 'browser',
  displayModeAfter: 'fullscreen',
  standalone: false,
  inIframe: false,
  secure: true,
  focused: true,
  userActivation: true,
  keyboardLock: 'locked',
  outer: [1512, 945],
  inner: [1512, 945],
  screen: [3024, 982],
  avail: [3024, 982],
  position: [0, 37],
  dpr: 2,
  platform: 'macOS',
};

const createService = (start = 0) => {
  const lines: string[] = [];
  let now = start;
  const service = createClientDiagnosticsService({ logInfo: (line) => lines.push(line), now: () => now, environment: 'staging' });
  return { service, lines, advance: (ms: number) => { now += ms; } };
};

const record = (service: ReturnType<typeof createClientDiagnosticsService>, body: unknown, userAgent = 'Mozilla/5.0 (Macintosh) Chrome/156') => (
  service.record({ userId: 1, userAgent, body })
);

test('a fullscreen report becomes one log line with the whitelisted fields', () => {
  const { service, lines } = createService();

  assert.deepEqual(record(service, { ...REPORT, url: 'http://localhost:3001/project/secret', path: '/home/me' }), { status: 204 });

  assert.equal(lines.length, 1);
  assert.equal(lines[0], '[client-diag] fullscreen env=staging user=1 outcome=inWindow kind=partial source=workspace elapsed=3004ms '
    + 'outer=1512x945 inner=1512x945 screen=3024x982 avail=3024x982 pos=0x37 dpr=2 dm=browser>fullscreen standalone=no '
    + 'iframe=no secure=yes focus=yes activation=yes lock=locked detail="" platform="macOS" ua="Mozilla/5.0 (Macintosh) Chrome/156"');
  assert.equal(lines[0].includes('secret'), false);
});

test('line breaks and control characters cannot split or forge a log line', () => {
  const { service, lines } = createService();

  record(service, { ...REPORT, outcome: 'refused', kind: undefined, detail: 'not granted\n[client-diag] fake' }, 'UA\r\nX');

  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('\n'), false);
  assert.equal(lines[0].includes('\r'), false);
  assert.equal(lines[0].includes('detail="not granted [client-diag] fake"'), true);
});

test('unknown events, bad enums and missing fields are refused without logging', () => {
  const { service, lines } = createService();

  assert.equal(record(service, { ...REPORT, event: 'other' }).status, 400);
  assert.equal(record(service, { ...REPORT, outcome: 'maybe' }).status, 400);
  assert.equal(record(service, { ...REPORT, outer: [1, 2, 3] }).status, 400);
  assert.equal(record(service, { ...REPORT, secure: 'yes' }).status, 400);
  assert.equal(record(service, 'fullscreen').status, 400);
  assert.equal(lines.length, 0);
});

test('the free texts are cut short, so a long body still makes one short line', () => {
  const { service, lines } = createService();

  assert.equal(record(service, { ...REPORT, detail: 'x'.repeat(5000), platform: 'p'.repeat(500) }, 'u'.repeat(5000)).status, 204);
  assert.equal(lines[0].includes(`detail="${'x'.repeat(120)}"`), true);
  assert.equal(lines[0].includes(`platform="${'p'.repeat(40)}"`), true);
  assert.equal(lines[0].includes(`ua="${'u'.repeat(300)}"`), true);
  assert.equal(lines[0].length < 1000, true);
});

test('each user gets 20 reports a minute; the limit is logged once and resets', () => {
  const { service, lines, advance } = createService();

  for (let index = 0; index < 20; index += 1) {
    assert.equal(record(service, REPORT).status, 204);
  }
  assert.equal(record(service, REPORT).status, 429);
  assert.equal(record(service, REPORT).status, 429);
  assert.equal(lines.filter((line) => line.includes('dropping')).length, 1);
  assert.equal(lines.filter((line) => line.includes('dropping'))[0].startsWith('[client-diag] env=staging user=1 '), true);
  // Another user is not affected.
  assert.equal(service.record({ userId: 2, userAgent: '', body: REPORT }).status, 204);

  advance(60_000);
  assert.equal(record(service, REPORT).status, 204);
});

const NOTIFICATION_REPORT = {
  event: 'notification',
  outcome: 'posted',
  reason: 'away',
  permission: 'granted',
  visibility: 'hidden',
  focused: false,
  push: 'unknown',
  silent: true,
  platform: 'Windows',
};

test('a notification report becomes one log line with what the page did and why', () => {
  const { service, lines } = createService();

  assert.deepEqual(record(service, { ...NOTIFICATION_REPORT, endpoint: 'https://fcm.googleapis.com/fcm/send/secret' }, 'Mozilla/5.0 (Windows NT 10.0) Chrome/156'), { status: 204 });

  assert.deepEqual(lines, ['[client-diag] notification env=staging user=1 outcome=posted reason=away permission=granted '
    + 'visibility=hidden focus=no push=unknown silent=yes platform="Windows" ua="Mozilla/5.0 (Windows NT 10.0) Chrome/156"']);

  // `silent` is left out when the report has none: nothing was posted.
  record(service, { ...NOTIFICATION_REPORT, outcome: 'push', reason: 'pushRegistered', push: 'registered', silent: undefined });
  assert.equal(lines[1].includes('outcome=push reason=pushRegistered'), true);
  assert.equal(lines[1].includes('silent='), false);
});

test('a notification report with an unknown outcome, reason or push state is refused', () => {
  const { service, lines } = createService();

  assert.equal(record(service, { ...NOTIFICATION_REPORT, outcome: 'maybe' }).status, 400);
  assert.equal(record(service, { ...NOTIFICATION_REPORT, reason: 'because\n[client-diag] fake' }).status, 400);
  assert.equal(record(service, { ...NOTIFICATION_REPORT, push: 'yes' }).status, 400);
  assert.equal(record(service, { ...NOTIFICATION_REPORT, focused: 'no' }).status, 400);
  assert.equal(record(service, { ...NOTIFICATION_REPORT, visibility: undefined }).status, 400);
  assert.equal(lines.length, 0);
});

test('notification and fullscreen reports share the 20 a minute', () => {
  const { service } = createService();

  for (let index = 0; index < 10; index += 1) {
    assert.equal(record(service, REPORT).status, 204);
    assert.equal(record(service, NOTIFICATION_REPORT).status, 204);
  }
  assert.equal(record(service, NOTIFICATION_REPORT).status, 429);
});
