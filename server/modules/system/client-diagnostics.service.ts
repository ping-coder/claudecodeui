type ClientDiagnosticsDependencies = {
  logInfo(line: string): void;
  now(): number;
  /** Which deployment logs the line ('production', 'staging'), so lines read from several units can be told apart. */
  environment: string;
};

type ClientDiagnosticsInput = {
  userId: number | string | null;
  userAgent: string | undefined;
  body: unknown;
};

type ClientDiagnosticsResult =
  | { status: 204 }
  | { status: 400 | 429; code: 'INVALID_DIAGNOSTICS' | 'RATE_LIMITED'; message: string };

/**
 * Reports one user may log per window; the rest are dropped with one line saying how many. The body
 * size is the app-wide JSON parser's limit; what reaches the log is bounded by the whitelist and the
 * text limits below.
 */
const MAX_REPORTS_PER_WINDOW = 20;
const RATE_WINDOW_MS = 60_000;
const MAX_USER_AGENT_LENGTH = 300;
const MAX_DETAIL_LENGTH = 120;
const MAX_PLATFORM_LENGTH = 40;
const MAX_DIMENSION = 100_000;

const SOURCES = ['workspace', 'codeEditor', 'prdEditor', 'browserUse'] as const;
const OUTCOMES = ['whole', 'inWindow', 'refused', 'unavailable', 'prefixed', 'interrupted'] as const;
const KINDS = ['tab', 'partial'] as const;
const CAUSES = ['desktopApp', 'iframe', 'noApi'] as const;
const DISPLAY_MODES = ['browser', 'minimal-ui', 'standalone', 'fullscreen', 'window-controls-overlay', 'picture-in-picture', 'unknown'] as const;
const KEYBOARD_LOCKS = ['requested', 'locked', 'failed', 'unsupported', 'insecure', 'notRequested'] as const;

class InvalidDiagnosticsError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** Control characters and line breaks would split or forge log lines; everything else is kept. */
const cleanText = (value: unknown, maxLength: number): string => (
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, maxLength) : ''
);

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new InvalidDiagnosticsError(`${field} is not one of ${allowed.join(', ')}`);
};

const pickOptionalEnum = <T extends string>(value: unknown, allowed: readonly T[], field: string): T | null => (
  value === undefined || value === null ? null : pickEnum(value, allowed, field)
);

const pickBoolean = (value: unknown, field: string): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new InvalidDiagnosticsError(`${field} must be a boolean`);
};

const pickInteger = (value: unknown, field: string, max = MAX_DIMENSION, min = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, Math.round(value)));
  }
  throw new InvalidDiagnosticsError(`${field} must be a number`);
};

const pickPair = (value: unknown, field: string): string => {
  if (Array.isArray(value) && value.length === 2) {
    return `${pickInteger(value[0], field, MAX_DIMENSION, -MAX_DIMENSION)}x${pickInteger(value[1], field, MAX_DIMENSION, -MAX_DIMENSION)}`;
  }
  throw new InvalidDiagnosticsError(`${field} must be [width, height]`);
};

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

/**
 * Formats one fullscreen report as a single log line: whitelisted fields only, enums checked,
 * numbers clamped, the two free texts (the browser's refusal message and the User-Agent header)
 * cut short and stripped of control characters. Anything else in the body is ignored.
 */
const formatFullscreenLine = (environment: string, userId: number | string | null, userAgent: string | undefined, body: Record<string, unknown>): string => {
  const outcome = pickEnum(body.outcome, OUTCOMES, 'outcome');
  const kind = pickOptionalEnum(body.kind, KINDS, 'kind');
  const cause = pickOptionalEnum(body.cause, CAUSES, 'cause');
  const userActivation = body.userActivation === null ? 'unknown' : yesNo(pickBoolean(body.userActivation, 'userActivation'));
  const dpr = typeof body.dpr === 'number' && Number.isFinite(body.dpr) ? Math.min(10, Math.max(0, Math.round(body.dpr * 100) / 100)) : 0;
  const fields = [
    `env=${environment}`,
    `user=${userId ?? 'unknown'}`,
    `outcome=${outcome}`,
    ...(kind ? [`kind=${kind}`] : []),
    ...(cause ? [`cause=${cause}`] : []),
    `source=${pickEnum(body.source, SOURCES, 'source')}`,
    `elapsed=${pickInteger(body.elapsedMs, 'elapsedMs', 600_000)}ms`,
    `outer=${pickPair(body.outer, 'outer')}`,
    `inner=${pickPair(body.inner, 'inner')}`,
    `screen=${pickPair(body.screen, 'screen')}`,
    `avail=${pickPair(body.avail, 'avail')}`,
    `pos=${pickPair(body.position, 'position')}`,
    `dpr=${dpr}`,
    `dm=${pickEnum(body.displayModeBefore, DISPLAY_MODES, 'displayModeBefore')}>${pickEnum(body.displayModeAfter, DISPLAY_MODES, 'displayModeAfter')}`,
    `standalone=${yesNo(pickBoolean(body.standalone, 'standalone'))}`,
    `iframe=${yesNo(pickBoolean(body.inIframe, 'inIframe'))}`,
    `secure=${yesNo(pickBoolean(body.secure, 'secure'))}`,
    `focus=${yesNo(pickBoolean(body.focused, 'focused'))}`,
    `activation=${userActivation}`,
    `lock=${pickEnum(body.keyboardLock, KEYBOARD_LOCKS, 'keyboardLock')}`,
    `detail=${JSON.stringify(cleanText(body.detail, MAX_DETAIL_LENGTH))}`,
    `platform=${JSON.stringify(cleanText(body.platform, MAX_PLATFORM_LENGTH))}`,
    `ua=${JSON.stringify(cleanText(userAgent, MAX_USER_AGENT_LENGTH))}`,
  ];
  return `[client-diag] fullscreen ${fields.join(' ')}`;
};

/**
 * Creates the service behind POST /api/system/client-diagnostics, which turns a browser's report
 * into one server log line so a problem seen on the user's machine can be read from the server's
 * log. Only the 'fullscreen' event exists. Each user gets MAX_REPORTS_PER_WINDOW reports a minute.
 */
export function createClientDiagnosticsService(dependencies: ClientDiagnosticsDependencies) {
  // Per user: when the current one-minute window started and how many reports came in it.
  const windows = new Map<string, { startedAt: number; count: number }>();

  const takeRateSlot = (userKey: string): boolean => {
    const now = dependencies.now();
    let slot = windows.get(userKey);
    if (!slot || now - slot.startedAt >= RATE_WINDOW_MS) {
      slot = { startedAt: now, count: 0 };
      windows.set(userKey, slot);
    }
    slot.count += 1;
    if (slot.count === MAX_REPORTS_PER_WINDOW + 1) {
      // Said once per window, so a page stuck in a loop cannot flood the log with this line either.
      dependencies.logInfo(`[client-diag] env=${dependencies.environment} user=${userKey} passed ${MAX_REPORTS_PER_WINDOW} reports a minute; dropping the rest of this minute`);
    }
    return slot.count <= MAX_REPORTS_PER_WINDOW;
  };

  return {
    /** Validates and logs one report; the route turns the result into the response status. */
    record(input: ClientDiagnosticsInput): ClientDiagnosticsResult {
      if (!isRecord(input.body) || input.body.event !== 'fullscreen') {
        return { status: 400, code: 'INVALID_DIAGNOSTICS', message: 'Unknown diagnostics event' };
      }
      let line: string;
      try {
        line = formatFullscreenLine(dependencies.environment, input.userId, input.userAgent, input.body);
      } catch (error) {
        if (error instanceof InvalidDiagnosticsError) {
          return { status: 400, code: 'INVALID_DIAGNOSTICS', message: error.message };
        }
        throw error;
      }
      if (!takeRateSlot(String(input.userId ?? 'unknown'))) {
        return { status: 429, code: 'RATE_LIMITED', message: 'Too many diagnostics reports' };
      }
      dependencies.logInfo(line);
      return { status: 204 };
    },
  };
}
