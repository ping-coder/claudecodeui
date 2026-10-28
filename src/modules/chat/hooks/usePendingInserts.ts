import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { InsertStatusEvent, OwnInsert, OwnInsertOutcome, PendingInsert } from '@/shared/types';

/**
 * sessionStorage key of the inserts this tab sent that have not ended. Per tab
 * on purpose: only the tab that sent an insert gets its text back.
 */
const OWN_INSERTS_STORAGE_KEY = 'chat-own-inserts';

/**
 * How long an insert may go without any answer before its text goes back into
 * the composer. It is not queued then: the server may still hold it, and a
 * message both inserted and queued would reach the model twice.
 */
const INSERT_ANSWER_TIMEOUT_MS = 5_000;

/**
 * How many inserts whose text went back unanswered are followed until their
 * fate is known. They are rare, and the oldest are forgotten first.
 */
const RETURNED_INSERTS_FOLLOWED = 20;

/**
 * A stored insert older than this is dropped rather than adopted after a
 * reload: whatever became of it, its text is no longer what the user is
 * writing, and the transcript page a reload reads may not reach back to it.
 */
const STORED_OWN_INSERT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Which mounted composer owns each insert this tab sent, so exactly one gets
 * an insert's text back: both panes of a split workspace hear every frame on
 * the page's one socket, and both read this tab's sessionStorage.
 */
const ownerByInsertId = new Map<string, symbol>();

const isOwnInsert = (value: unknown): value is OwnInsert => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.insertId === 'string'
    && typeof candidate.sessionId === 'string'
    && typeof candidate.content === 'string'
    && typeof candidate.sentAt === 'number'
    && typeof candidate.accepted === 'boolean';
};

const readStoredOwnInserts = (): OwnInsert[] => {
  try {
    const raw = window.sessionStorage.getItem(OWN_INSERTS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isOwnInsert) : [];
  } catch {
    return [];
  }
};

const writeStoredOwnInserts = (inserts: OwnInsert[]): void => {
  try {
    if (inserts.length === 0) {
      window.sessionStorage.removeItem(OWN_INSERTS_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(OWN_INSERTS_STORAGE_KEY, JSON.stringify(inserts));
    }
  } catch {
    // Storage unavailable: only a reload loses the insert's text then.
  }
};

const storeOwnInsert = (insert: OwnInsert): void => {
  writeStoredOwnInserts([
    ...readStoredOwnInserts().filter((stored) => stored.insertId !== insert.insertId),
    insert,
  ]);
};

const forgetStoredOwnInsert = (insertId: string): void => {
  const stored = readStoredOwnInserts();
  const remaining = stored.filter((insert) => insert.insertId !== insertId);
  if (remaining.length !== stored.length) {
    writeStoredOwnInserts(remaining);
  }
};

/**
 * A v4 UUID for a new insert; the server takes nothing else. `randomUUID`
 * exists only in secure contexts, and CloudCLI is often opened over plain HTTP
 * from another machine on the network, where only `getRandomValues` does.
 */
const createInsertId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

type UsePendingInsertsArgs = {
  /** The session on screen: the card lists its inserts, and this tab's stored inserts of it are adopted. */
  sessionId: string | null;
  sendMessage: (message: unknown) => void;
  /** Hears, once, how each insert this composer sent ended. */
  onOwnInsertSettled: (insert: OwnInsert, outcome: OwnInsertOutcome) => void;
  /**
   * Hears, once, how an insert that ended unanswered (its text went back after
   * INSERT_ANSWER_TIMEOUT_MS) turned out: `delivered` when the model read it
   * after all, as a late status or the transcript at the run's end says.
   */
  onReturnedInsertEnded: (insert: OwnInsert, delivered: boolean) => void;
  /**
   * Which of the given message ids the session's transcript holds once its
   * latest page is re-read. A run that ended unheard (the socket was away, or
   * the page reloaded) tells a delivered insert, whose message carries the
   * insertId, from one that never landed this way.
   */
  findTranscriptMessages: (sessionId: string, messageIds: string[]) => Promise<Set<string>>;
};

/**
 * Used by chat's useChatComposerState to keep the mid-run inserts of one
 * composer: the card list that every pane and tab on a session shows, fed by
 * `insert_status` frames, and the inserts this composer sent until each ends.
 *
 * An insert this composer sent is listed at once, before the server answers;
 * one sent elsewhere appears with its `pending` frame. Its end removes it from
 * every list, and only the composer that sent it hears how it ended. An insert
 * left without any answer for INSERT_ANSWER_TIMEOUT_MS ends as unanswered, yet
 * is still followed: a late acceptance is withdrawn, and a late delivery is
 * reported, as its text went back. One a run ended without reporting (the
 * socket was away) is looked for in the transcript. Own inserts are mirrored
 * to sessionStorage, so the composer that shows a session after a reload
 * adopts the ones sent from it before.
 */
export function usePendingInserts({
  sessionId,
  sendMessage,
  onOwnInsertSettled,
  onReturnedInsertEnded,
  findTranscriptMessages,
}: UsePendingInsertsArgs) {
  // Every insert this chat has heard of that the model has not read yet, in
  // the order they were sent or announced, across sessions: a session switch
  // must not lose the ones of the session left, whose frames keep coming. The
  // card shows the open session's. Event handlers read the ref, which is
  // always current; the state only renders it.
  const [entries, setEntries] = useState<PendingInsert[]>([]);
  const entriesRef = useRef<PendingInsert[]>([]);
  // This composer's own inserts that have not ended, by id.
  const ownInsertsRef = useRef(new Map<string, OwnInsert>());
  // The timers of own inserts the server has not answered yet.
  const answerTimersRef = useRef(new Map<string, number>());
  // Own inserts whose text went back for want of an answer, by id, until
  // their fate is known. A `pending` that still comes is withdrawn, as the text
  // is back in the composer; a delivery that still comes, or the transcript
  // once the run is over, tells the composer the model read it after all.
  const returnedInsertsRef = useRef(new Map<string, { insert: OwnInsert; withdrawn: boolean }>());
  // This composer's mark in ownerByInsertId, made once per mount: what tells
  // its own inserts from those of another composer on the page.
  const [ownerToken] = useState(() => Symbol('chat-composer'));
  // What timers and frame handlers call: the latest committed render's.
  const callbacksRef = useRef({ sendMessage, onOwnInsertSettled, onReturnedInsertEnded, findTranscriptMessages });
  useLayoutEffect(() => {
    callbacksRef.current = { sendMessage, onOwnInsertSettled, onReturnedInsertEnded, findTranscriptMessages };
  });

  const commitEntries = useCallback((next: PendingInsert[]) => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const upsertEntry = useCallback((entry: PendingInsert) => {
    const current = entriesRef.current;
    const index = current.findIndex((existing) => existing.insertId === entry.insertId);
    commitEntries(index < 0
      ? [...current, entry]
      : current.map((existing, existingIndex) => (existingIndex === index ? entry : existing)));
  }, [commitEntries]);

  const removeEntries = useCallback((shouldRemove: (entry: PendingInsert) => boolean) => {
    const current = entriesRef.current;
    const next = current.filter((entry) => !shouldRemove(entry));
    if (next.length !== current.length) {
      commitEntries(next);
    }
  }, [commitEntries]);

  const clearAnswerTimer = useCallback((insertId: string) => {
    const timer = answerTimersRef.current.get(insertId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      answerTimersRef.current.delete(insertId);
    }
  }, []);

  const claimOwnInsert = useCallback((insert: OwnInsert) => {
    ownInsertsRef.current.set(insert.insertId, insert);
    ownerByInsertId.set(insert.insertId, ownerToken);
  }, [ownerToken]);

  // Ends an own insert everywhere it is kept, then tells the composer, once.
  const settleOwnInsert = useCallback((insertId: string, outcome: OwnInsertOutcome) => {
    const insert = ownInsertsRef.current.get(insertId);
    if (!insert) {
      return;
    }
    ownInsertsRef.current.delete(insertId);
    clearAnswerTimer(insertId);
    if (ownerByInsertId.get(insertId) === ownerToken) {
      ownerByInsertId.delete(insertId);
    }
    forgetStoredOwnInsert(insertId);
    callbacksRef.current.onOwnInsertSettled(insert, outcome);
  }, [clearAnswerTimer, ownerToken]);

  const startAnswerTimer = useCallback((insertId: string) => {
    clearAnswerTimer(insertId);
    answerTimersRef.current.set(insertId, window.setTimeout(() => {
      answerTimersRef.current.delete(insertId);
      const insert = ownInsertsRef.current.get(insertId);
      if (!insert) {
        return;
      }
      const returned = returnedInsertsRef.current;
      returned.set(insertId, { insert, withdrawn: false });
      if (returned.size > RETURNED_INSERTS_FOLLOWED) {
        const oldestInsertId = returned.keys().next().value;
        if (oldestInsertId !== undefined) {
          returned.delete(oldestInsertId);
        }
      }
      removeEntries((entry) => entry.insertId === insertId);
      settleOwnInsert(insertId, { kind: 'returned', reason: 'noResponse' });
    }, INSERT_ANSWER_TIMEOUT_MS));
  }, [clearAnswerTimer, removeEntries, settleOwnInsert]);

  // Ends the following of an insert whose text went back unanswered, telling
  // the composer whether the model read it after all; false when it was not
  // followed (any more).
  const endReturnedInsert = useCallback((insertId: string, delivered: boolean): boolean => {
    const returned = returnedInsertsRef.current.get(insertId);
    if (!returned) {
      return false;
    }
    returnedInsertsRef.current.delete(insertId);
    callbacksRef.current.onReturnedInsertEnded(returned.insert, delivered);
    return true;
  }, []);

  // Takes over a stored insert of this tab that no mounted composer owns: one
  // whose composer has since unmounted.
  const claimStoredInsert = useCallback((insertId: string): OwnInsert | undefined => {
    if (ownerByInsertId.has(insertId)) {
      return undefined;
    }
    const stored = readStoredOwnInserts().find((insert) => insert.insertId === insertId);
    if (stored) {
      claimOwnInsert(stored);
    }
    return stored;
  }, [claimOwnInsert]);

  /** Sends `content` into the session's running turn; returns the new insert's id. */
  const sendInsert = useCallback((targetSessionId: string, content: string): string => {
    const insert: OwnInsert = {
      insertId: createInsertId(),
      sessionId: targetSessionId,
      content,
      sentAt: Date.now(),
      accepted: false,
    };
    claimOwnInsert(insert);
    storeOwnInsert(insert);
    upsertEntry({ insertId: insert.insertId, sessionId: targetSessionId, content, state: 'sending' });
    startAnswerTimer(insert.insertId);
    callbacksRef.current.sendMessage({
      type: 'chat.insert',
      sessionId: targetSessionId,
      insertId: insert.insertId,
      content,
    });
    return insert.insertId;
  }, [claimOwnInsert, startAnswerTimer, upsertEntry]);

  /** Asks the server to take back an insert the model has not read; any pane or tab may. */
  const withdrawInsert = useCallback((insertId: string) => {
    const entry = entriesRef.current.find((candidate) => candidate.insertId === insertId);
    if (!entry || entry.state !== 'pending') {
      return;
    }
    upsertEntry({ ...entry, state: 'withdrawing' });
    callbacksRef.current.sendMessage({ type: 'chat.insert-cancel', sessionId: entry.sessionId, insertId });
  }, [upsertEntry]);

  /** Applies one `insert_status` frame; the realtime handler hands each insert's status over once. */
  const handleInsertStatus = useCallback((event: InsertStatusEvent) => {
    const { insertId, insertStatus } = event;
    const ownInsert = ownInsertsRef.current.get(insertId) ?? claimStoredInsert(insertId);
    const entry = entriesRef.current.find((candidate) => candidate.insertId === insertId);

    switch (insertStatus) {
      case 'pending': {
        const returned = returnedInsertsRef.current.get(insertId);
        if (returned) {
          // Its text went back into the composer already, where the user may
          // send it again: the late insert is taken back rather than read.
          const lateSessionId = event.sessionId ?? returned.insert.sessionId;
          if (!returned.withdrawn && lateSessionId) {
            returned.withdrawn = true;
            callbacksRef.current.sendMessage({ type: 'chat.insert-cancel', sessionId: lateSessionId, insertId });
          }
          return;
        }
        if (ownInsert && !ownInsert.accepted) {
          const accepted = { ...ownInsert, accepted: true };
          ownInsertsRef.current.set(insertId, accepted);
          storeOwnInsert(accepted);
          clearAnswerTimer(insertId);
        }
        const entrySessionId = ownInsert?.sessionId ?? event.sessionId;
        if (!entrySessionId) {
          return;
        }
        if (!entry) {
          upsertEntry({
            insertId,
            sessionId: entrySessionId,
            content: event.content || ownInsert?.content || '',
            state: 'pending',
          });
        } else if (entry.state === 'sending') {
          upsertEntry({ ...entry, state: 'pending' });
        }
        return;
      }
      case 'cancel_failed': {
        // No reason means the CLI is already reading it; any other is the
        // server's own word on why nothing was withdrawn.
        if (entry) {
          upsertEntry({ ...entry, state: event.insertReason ? 'withdrawFailed' : 'delivering' });
        }
        return;
      }
      case 'delivered':
      case 'next_turn':
        removeEntries((candidate) => candidate.insertId === insertId);
        // Too late to withdraw: the model read the text that went back.
        if (endReturnedInsert(insertId, true)) {
          return;
        }
        settleOwnInsert(insertId, { kind: 'delivered' });
        return;
      case 'cancelled':
      case 'failed':
        removeEntries((candidate) => candidate.insertId === insertId);
        if (endReturnedInsert(insertId, false)) {
          return;
        }
        settleOwnInsert(insertId, { kind: 'returned', reason: insertStatus });
        return;
      case 'refused':
        removeEntries((candidate) => candidate.insertId === insertId);
        // Refused after its text went back: there is nothing to fall back on.
        if (endReturnedInsert(insertId, false)) {
          return;
        }
        settleOwnInsert(insertId, { kind: 'refused', reason: event.insertReason ?? '' });
        return;
      default:
        return;
    }
  }, [claimStoredInsert, clearAnswerTimer, endReturnedInsert, removeEntries, settleOwnInsert, upsertEntry]);

  /**
   * A session's run is over, so none of its inserts reports anything more.
   * Others' leave the card. This composer's own ones are looked for in the
   * transcript, and end delivered when found or are given back when not:
   * after an idle subscribe ack (`sentBefore` is when the subscribe went out),
   * every one sent before that subscribe, since the socket answers in order
   * and anything still unanswered was answered to a socket now gone; after a
   * `complete` (`sentBefore` null), only the accepted ones, as the server may
   * still be refusing one sent just as the turn ended. An own insert whose
   * text went back unanswered, sent before that point, is looked for too: one
   * the transcript holds reached the model after all.
   */
  const handleInsertRunEnded = useCallback((endedSessionId: string, sentBefore: number | null) => {
    removeEntries((entry) => entry.sessionId === endedSessionId && !ownInsertsRef.current.has(entry.insertId));
    const unsettled = [...ownInsertsRef.current.values()].filter((insert) => (
      insert.sessionId === endedSessionId
      && (sentBefore === null ? insert.accepted : insert.sentAt < sentBefore)
    ));
    const returned = [...returnedInsertsRef.current.values()]
      .map(({ insert }) => insert)
      .filter((insert) => insert.sessionId === endedSessionId && (sentBefore === null || insert.sentAt < sentBefore));
    if (unsettled.length === 0 && returned.length === 0) {
      return;
    }

    void (async () => {
      let found = new Set<string>();
      try {
        found = await callbacksRef.current.findTranscriptMessages(
          endedSessionId,
          [...unsettled, ...returned].map((insert) => insert.insertId),
        );
      } catch {
        // Unreadable: the text goes back, as a message sent twice beats one lost.
      }
      for (const insert of unsettled) {
        // Its own final status may have come while the transcript was read.
        if (!ownInsertsRef.current.has(insert.insertId)) {
          continue;
        }
        removeEntries((entry) => entry.insertId === insert.insertId);
        settleOwnInsert(
          insert.insertId,
          found.has(insert.insertId) ? { kind: 'delivered' } : { kind: 'returned', reason: 'notDelivered' },
        );
      }
      for (const insert of returned) {
        endReturnedInsert(insert.insertId, found.has(insert.insertId));
      }
    })();
  }, [endReturnedInsert, removeEntries, settleOwnInsert]);

  // Adopts this tab's stored inserts of the session on screen that no mounted
  // composer owns: the ones sent before a reload. One the server has not
  // answered gets a fresh timer, since the reload dropped the one it had.
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const now = Date.now();
    const stored = readStoredOwnInserts();
    const fresh = stored.filter((insert) => now - insert.sentAt < STORED_OWN_INSERT_MAX_AGE_MS);
    if (fresh.length !== stored.length) {
      writeStoredOwnInserts(fresh);
    }
    for (const insert of fresh) {
      if (insert.sessionId !== sessionId || ownerByInsertId.has(insert.insertId)) {
        continue;
      }
      claimOwnInsert(insert);
      upsertEntry({
        insertId: insert.insertId,
        sessionId: insert.sessionId,
        content: insert.content,
        state: insert.accepted ? 'pending' : 'sending',
      });
      if (!insert.accepted) {
        startAnswerTimer(insert.insertId);
      }
    }
  }, [claimOwnInsert, sessionId, startAnswerTimer, upsertEntry]);

  // An unmounted composer can give no text back: its timers stop and its
  // claims go, so another composer showing the session, or the next page load,
  // adopts its inserts from storage.
  useEffect(() => {
    const timers = answerTimersRef.current;
    const ownInserts = ownInsertsRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      for (const insertId of ownInserts.keys()) {
        if (ownerByInsertId.get(insertId) === ownerToken) {
          ownerByInsertId.delete(insertId);
        }
      }
    };
  }, [ownerToken]);

  const pendingInserts = useMemo(
    () => entries.filter((entry) => entry.sessionId === sessionId),
    [entries, sessionId],
  );

  return {
    pendingInserts,
    sendInsert,
    withdrawInsert,
    handleInsertStatus,
    handleInsertRunEnded,
  };
}
