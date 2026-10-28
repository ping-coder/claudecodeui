import type { QueuedChatMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type GitConfig = {
  git_name: string | null;
  git_email: string | null;
};

/** One chat scope's unsent composer text and queued message. */
type DraftRecord = {
  scope: string;
  text: string;
  queuedMessage: unknown | null;
  updatedAt: string;
};

type UserDependencies = {
  users: {
    getGitConfig(userId: number): GitConfig | undefined;
    updateGitConfig(userId: number, gitName: string | null, gitEmail: string | null): void;
    completeOnboarding(userId: number): void;
    hasCompletedOnboarding(userId: number): boolean;
  };
  preferences: {
    getPreferences(userId: number): Record<string, unknown>;
    savePreferences(userId: number, updates: Record<string, unknown>): void;
    patchPreferences(
      userId: number,
      set: Record<string, unknown>,
      merge: Record<string, Record<string, unknown>>,
    ): void;
  };
  drafts: {
    getDrafts(userId: number): DraftRecord[];
    saveDraft(userId: number, scope: string, draft: { text: string; queuedMessage: unknown | null }): void;
    saveDraftText(userId: number, scope: string, text: string): void;
    appendQueuedMessage(
      userId: number,
      scope: string,
      message: QueuedChatMessage,
    ): { queuedMessage: QueuedChatMessage; appended: boolean } | null;
    clearQueuedMessage(userId: number, scope: string): void;
    deleteDraft(userId: number, scope: string): void;
  };
  readSystemGitConfig(): Promise<GitConfig>;
  applyGlobalGitConfig(gitName: string, gitEmail: string): Promise<void>;
  logInfo(message: string): void;
  logError(message: string, error: unknown): void;
};

/**
 * The longest a draft scope or preference key may be.
 *
 * Scopes are session UUIDs or `project:<id>`, and preference keys are fixed
 * identifiers, so anything longer is a client bug or an attempt to use the
 * table as general storage.
 */
const MAX_KEY_LENGTH = 200;

/** Guards against a runaway composer filling the database with one row. */
const MAX_DRAFT_TEXT_LENGTH = 100_000;

const readDraftScope = (value: unknown): string => {
  const scope = typeof value === 'string' ? value.trim() : '';
  if (!scope || scope.length > MAX_KEY_LENGTH) {
    throw new AppError('A draft scope of 1-200 characters is required', {
      code: 'INVALID_DRAFT_SCOPE',
      statusCode: 400,
    });
  }
  return scope;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/** Reads the message the composer asks to queue; one with nothing to send is refused. */
const readQueuedMessageInput = (value: unknown): QueuedChatMessage => {
  const message = isPlainObject(value) ? value : {};
  const content = typeof message.content === 'string' ? message.content : '';
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!content.trim() && attachments.length === 0) {
    throw new AppError('A queued message needs text or attachments', {
      code: 'INVALID_QUEUED_MESSAGE',
      statusCode: 400,
    });
  }
  return {
    content,
    ...(isPlainObject(message.options) ? { options: message.options } : {}),
    attachments,
  };
};

const readPreferenceUpdates = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Preferences must be sent as an object', {
      code: 'INVALID_PREFERENCES',
      statusCode: 400,
    });
  }

  const updates = body as Record<string, unknown>;
  for (const key of Object.keys(updates)) {
    if (!key || key.length > MAX_KEY_LENGTH) {
      throw new AppError('Preference keys must be 1-200 characters', {
        code: 'INVALID_PREFERENCE_KEY',
        statusCode: 400,
      });
    }
  }

  return updates;
};

type PreferencePatchGroup = 'set' | 'merge';

const PREFERENCE_PATCH_GROUPS: PreferencePatchGroup[] = ['set', 'merge'];

const invalidPreferencePatch = (message: string) => new AppError(message, {
  code: 'INVALID_PREFERENCES',
  statusCode: 400,
});

/** Reads one group of a merge-route body; an absent group is empty. */
const readPreferencePatchGroup = (body: Record<string, unknown>, group: PreferencePatchGroup) => {
  const value = body[group];
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw invalidPreferencePatch(`"${group}" must be an object`);
  }
  return readPreferenceUpdates(value);
};

/**
 * Reads a PATCH /preferences/merge body: `{ set?: {...}, merge?: {...} }`.
 * Keys follow the same 1-200 character rule as PATCH /preferences, and every
 * `merge` value must be an object, because its fields are what get merged.
 */
const readPreferencePatch = (body: unknown) => {
  if (!isPlainObject(body)) {
    throw invalidPreferencePatch('Preferences must be sent as an object');
  }
  const unknownField = Object.keys(body).find(
    (field) => !PREFERENCE_PATCH_GROUPS.includes(field as PreferencePatchGroup),
  );
  if (unknownField !== undefined) {
    throw invalidPreferencePatch(`Unknown field "${unknownField}": only "set" and "merge" are accepted`);
  }

  const set = readPreferencePatchGroup(body, 'set');
  const merge = readPreferencePatchGroup(body, 'merge');
  for (const [key, patch] of Object.entries(merge)) {
    if (!isPlainObject(patch)) {
      throw invalidPreferencePatch(`The merge value for "${key}" must be an object`);
    }
  }
  return { set, merge: merge as Record<string, Record<string, unknown>> };
};

/** Creates user-profile workflows with explicit repository and Git adapters. */
export function createUserService(dependencies: UserDependencies) {
  return {
    async getGitConfig(userId: number) {
      let gitConfig = dependencies.users.getGitConfig(userId);
      if (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email)) {
        const systemConfig = await dependencies.readSystemGitConfig();
        if (systemConfig.git_name || systemConfig.git_email) {
          dependencies.users.updateGitConfig(
            userId,
            systemConfig.git_name,
            systemConfig.git_email,
          );
          gitConfig = systemConfig;
          dependencies.logInfo(`Auto-populated Git config for user ${userId}`);
        }
      }

      return {
        success: true,
        gitName: gitConfig?.git_name ?? null,
        gitEmail: gitConfig?.git_email ?? null,
      };
    },

    async updateGitConfig(userId: number, gitNameInput: unknown, gitEmailInput: unknown) {
      const gitName = typeof gitNameInput === 'string' ? gitNameInput.trim() : '';
      const gitEmail = typeof gitEmailInput === 'string' ? gitEmailInput.trim() : '';
      if (!gitName || !gitEmail) {
        throw new AppError('Git name and email are required', {
          code: 'GIT_CONFIG_REQUIRED',
          statusCode: 400,
        });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gitEmail)) {
        throw new AppError('Invalid email format', {
          code: 'INVALID_GIT_EMAIL',
          statusCode: 400,
        });
      }

      dependencies.users.updateGitConfig(userId, gitName, gitEmail);
      try {
        await dependencies.applyGlobalGitConfig(gitName, gitEmail);
      } catch (error) {
        // Persisted user settings remain authoritative even if the host Git
        // installation cannot be updated (matching the previous behavior).
        dependencies.logError('Failed to apply global Git config', error);
      }
      return { success: true, gitName, gitEmail };
    },

    completeOnboarding(userId: number) {
      dependencies.users.completeOnboarding(userId);
      return { success: true, message: 'Onboarding completed successfully' };
    },

    getOnboardingStatus(userId: number) {
      return {
        success: true,
        hasCompletedOnboarding: dependencies.users.hasCompletedOnboarding(userId),
      };
    },

    /** Every stored preference at once; the client fills gaps with its defaults. */
    getPreferences(userId: number) {
      return { success: true, preferences: dependencies.preferences.getPreferences(userId) };
    },

    /**
     * Only the keys in the request body are touched, and each of them is
     * replaced whole, so two settings screens saving different keys never
     * erase each other's work. Pages built before PATCH /preferences/merge
     * save every key here, and current pages fall back to it for a server
     * that does not have that route.
     */
    savePreferences(userId: number, body: unknown) {
      const updates = readPreferenceUpdates(body);
      dependencies.preferences.savePreferences(userId, updates);
      return { success: true, preferences: dependencies.preferences.getPreferences(userId) };
    },

    /**
     * `set` keys are replaced whole, as savePreferences does. Each `merge` key
     * names some fields of an object preference: those fields are written (a
     * null one removed) and the stored fields not named are kept, so a page
     * that changed one editor setting cannot put back an older copy of the
     * others.
     */
    patchPreferences(userId: number, body: unknown) {
      const { set, merge } = readPreferencePatch(body);
      dependencies.preferences.patchPreferences(userId, set, merge);
      return { success: true, preferences: dependencies.preferences.getPreferences(userId) };
    },

    getDrafts(userId: number) {
      return { success: true, drafts: dependencies.drafts.getDrafts(userId) };
    },

    saveDraft(userId: number, scopeInput: unknown, body: unknown) {
      const scope = readDraftScope(scopeInput);
      const payload = (body ?? {}) as { text?: unknown; queuedMessage?: unknown };
      const text = typeof payload.text === 'string' ? payload.text : '';

      if (text.length > MAX_DRAFT_TEXT_LENGTH) {
        throw new AppError('Draft text is too long to store', {
          code: 'DRAFT_TEXT_TOO_LONG',
          statusCode: 413,
        });
      }

      // The composer's debounced save sends only the text. Its copy of the
      // queued message can be stale (already claimed by the dispatcher, or added
      // to from another tab), so a save without one leaves the stored one alone.
      if (payload.queuedMessage === undefined) {
        dependencies.drafts.saveDraftText(userId, scope, text);
        return { success: true };
      }

      dependencies.drafts.saveDraft(userId, scope, {
        text,
        queuedMessage: payload.queuedMessage ?? null,
      });
      return { success: true };
    },

    /**
     * Queues a message behind the session's running turn. A message already
     * waiting there is kept and this one is added after it, so a burst of
     * follow-ups all reach the provider, in order, as the next turn.
     *
     * A slash command is the one exception: it only works as a turn of its
     * own, so it is refused rather than merged, and the composer keeps it.
     */
    appendQueuedMessage(userId: number, scopeInput: unknown, queuedMessageInput: unknown) {
      const scope = readDraftScope(scopeInput);
      const message = readQueuedMessageInput(queuedMessageInput);
      const result = dependencies.drafts.appendQueuedMessage(userId, scope, message);
      if (!result) {
        throw new AppError(
          'A slash command runs as a turn of its own, so it cannot be combined with the queued message. '
            + 'Send it after the queued message has gone.',
          { code: 'QUEUED_MESSAGE_NOT_COMBINABLE', statusCode: 409 },
        );
      }
      return { success: true, queuedMessage: result.queuedMessage, appended: result.appended };
    },

    clearQueuedMessage(userId: number, scopeInput: unknown) {
      dependencies.drafts.clearQueuedMessage(userId, readDraftScope(scopeInput));
      return { success: true };
    },

    deleteDraft(userId: number, scopeInput: unknown) {
      dependencies.drafts.deleteDraft(userId, readDraftScope(scopeInput));
      return { success: true };
    },
  };
}
