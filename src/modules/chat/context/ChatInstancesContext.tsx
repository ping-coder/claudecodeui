import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';

/**
 * How many page-effect keys the page remembers, oldest forgotten first. A key has to outlive the
 * websocket dispatch in which every chat hears its frame, and a permission prompt's key also the
 * later subscribe ack or replay that announces the prompt again; the bound keeps a long-lived page
 * from growing the set without end.
 */
const PAGE_EFFECT_KEY_LIMIT = 500;

/** One mounted chat as the page sees it; read at event time, so always its latest view and focus. */
type ChatInstance = {
  getViewedSessionId: () => string | null;
  getIsFocused: () => boolean;
};

/** The state every ChatInterface on the page shares, created once per ChatInstancesProvider. */
type ChatInstancesRegistry = {
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  claimPageEffect: (eventKey: string) => boolean;
  /** Adds an instance after those already mounted; returns its removal. */
  register: (instance: ChatInstance) => () => void;
  /** The instance that writes a session's background work into the shared activity map. */
  findBackgroundReporter: (sessionId: string) => ChatInstance | null;
};

function createChatInstancesRegistry(): ChatInstancesRegistry {
  // Registration order: the first entry is the earliest mounted chat still on the page.
  const instances: ChatInstance[] = [];
  const claimedEventKeys = new Set<string>();

  return {
    statusCheckSentAtRef: { current: new Map<string, number>() },
    claimPageEffect: (eventKey) => {
      if (claimedEventKeys.has(eventKey)) {
        return false;
      }
      claimedEventKeys.add(eventKey);
      if (claimedEventKeys.size > PAGE_EFFECT_KEY_LIMIT) {
        // A Set iterates in insertion order, so the first key is the oldest.
        const oldestKey = claimedEventKeys.values().next().value;
        if (oldestKey !== undefined) {
          claimedEventKeys.delete(oldestKey);
        }
      }
      return true;
    },
    register: (instance) => {
      instances.push(instance);
      return () => {
        const index = instances.indexOf(instance);
        if (index >= 0) {
          instances.splice(index, 1);
        }
      };
    },
    // A chat showing the session reads it from a store that holds its whole history, so a viewer
    // reports when there is one, the focused viewer first. A session nobody shows still needs a
    // reporter, or its background work would never settle: the earliest mounted chat takes it.
    findBackgroundReporter: (sessionId) => {
      const viewers = instances.filter((instance) => instance.getViewedSessionId() === sessionId);
      return viewers.find((instance) => instance.getIsFocused()) ?? viewers[0] ?? instances[0] ?? null;
    },
  };
}

const ChatInstancesContext = createContext<ChatInstancesRegistry | null>(null);

/**
 * Exported through the chat barrel; mounted once by project-workspace's ProjectWorkspaceRoute so
 * every ChatInterface on the page shares one realtime coordinator: one record of subscribe times,
 * one writer of each session's background work, and each permission prompt's sound played once.
 */
export function ChatInstancesProvider({ children }: { children: ReactNode }) {
  // The page's registry, kept for the provider's lifetime: a lazy state initializer is how React
  // guarantees the same object on every render. Never set again.
  const [registry] = useState(createChatInstancesRegistry);
  return <ChatInstancesContext.Provider value={registry}>{children}</ChatInstancesContext.Provider>;
}

type ChatInstanceCoordinatorArgs = {
  /** The session the chat shows: its selection, else the session its first send created. */
  getViewedSessionId: () => string | null;
  /** Whether the chat's pane is the focused one. */
  getIsFocused: () => boolean;
};

/** What one chat takes from the page's coordinator. */
type ChatInstanceCoordinator = {
  /** When each session's `chat.subscribe` was last sent, by any chat on the page; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** True for the first claim of an event key (a permission prompt's sound), false for every later one. */
  claimPageEffect: (eventKey: string) => boolean;
  /** Whether this chat writes the session's remaining background work into the activity map. */
  isBackgroundReporter: (sessionId: string) => boolean;
};

/**
 * Joins one ChatInterface to the page's realtime coordinator; the three pieces are handed to
 * useChatRealtimeHandlers (and the subscribe times to useChatSessionState).
 *
 * Without a ChatInstancesProvider (tests, a chat rendered on its own) the chat keeps the behaviour
 * it had before the split: its own subscribe times, every page effect, every background report.
 */
export function useChatInstanceCoordinator({
  getViewedSessionId,
  getIsFocused,
}: ChatInstanceCoordinatorArgs): ChatInstanceCoordinator {
  const registry = useContext(ChatInstancesContext);

  // The getters of the latest commit, so an election made from a websocket listener reads the
  // current view and focus whatever getters the caller passes on each render.
  const gettersRef = useRef({ getViewedSessionId, getIsFocused });
  useLayoutEffect(() => {
    gettersRef.current = { getViewedSessionId, getIsFocused };
  });

  // This chat's entry in the registry. Stable for the chat's life, so it keeps its place in the
  // registration order; never set again.
  const [instance] = useState<ChatInstance>(() => ({
    getViewedSessionId: () => gettersRef.current.getViewedSessionId(),
    getIsFocused: () => gettersRef.current.getIsFocused(),
  }));

  useEffect(() => registry?.register(instance), [instance, registry]);

  // Subscribe times of this chat alone, used only when no provider shares the page's.
  const localStatusCheckSentAtRef = useRef(new Map<string, number>());

  const claimPageEffect = useCallback(
    (eventKey: string): boolean => (registry ? registry.claimPageEffect(eventKey) : true),
    [registry],
  );

  const isBackgroundReporter = useCallback(
    (sessionId: string): boolean => (registry ? registry.findBackgroundReporter(sessionId) === instance : true),
    [instance, registry],
  );

  return {
    statusCheckSentAtRef: registry?.statusCheckSentAtRef ?? localStatusCheckSentAtRef,
    claimPageEffect,
    isBackgroundReporter,
  };
}
