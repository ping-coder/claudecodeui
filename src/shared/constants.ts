import {
  Bell,
  Bot,
  GitBranch,
  Info,
  KeyRound,
  ListChecks,
  MonitorPlay,
  Palette,
  Plug,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type {
  FileStatusCode,
  LLMProvider,
  McpProvider,
  McpScope,
  McpTransport,
  SettingsMainTab,
  WorkspacePaneSide,
} from '@/shared/types';
import type { UserPreferenceKey } from '@/shared/userSettings';

/** The four buckets the git changes view sorts working-tree files into. */
type GitStatusFileGroup = 'modified' | 'added' | 'deleted' | 'untracked';

//----------------- BRANDING ------------

/**
 * Font stack used to render the CloudCLI wordmark consistently wherever the brand name
 * appears as text. Apply it inline so the wordmark does not inherit a themed font.
 */
export const CLOUDCLI_WORDMARK_FONT_FAMILY =
  'ui-sans-serif, system-ui, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji';

// ---------------------------

//----------------- APPLICATION VERSION ------------

/**
 * Version of the installed package, baked into the client bundle at build time.
 * Compare it with the version reported by `/health` to detect a package that was
 * updated without restarting the server. Empty outside a Vite build (for example
 * under the `tsx` test runner), where no build-time value is injected.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

// ---------------------------

//----------------- SETTINGS NAVIGATION ------------

/** Shape of one entry in `SETTINGS_MAIN_TABS`; only that constant needs it. */
type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
};

/**
 * The ordered list of top-level settings tabs. The settings sidebar renders it directly and
 * the command palette turns each entry into an "open settings" command, so both stay in sync.
 */
export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  { id: 'agents', label: 'Agents', keywords: 'agents subagents claude code', icon: Bot },
  { id: 'appearance', label: 'Appearance', keywords: 'appearance theme dark light language', icon: Palette },
  { id: 'git', label: 'Git', keywords: 'git github commits', icon: GitBranch },
  { id: 'api', label: 'API Tokens', keywords: 'api tokens auth keys', icon: KeyRound },
  { id: 'tasks', label: 'Tasks', keywords: 'tasks taskmaster', icon: ListChecks },
  { id: 'browser', label: 'Browser', keywords: 'browser playwright chromium automation', icon: MonitorPlay },
  { id: 'notifications', label: 'Notifications', keywords: 'notifications alerts push', icon: Bell },
  { id: 'plugins', label: 'Plugins', keywords: 'plugins extensions integrations', icon: Plug },
  { id: 'about', label: 'About', keywords: 'about version info', icon: Info },
];

// ---------------------------

//----------------- CHAT REASONING EFFORT ------------

/**
 * Sentinel effort value meaning "use whatever the model defaults to". The composer's model
 * menu renders it as the first choice and the provider state treats it as "no explicit effort".
 */
export const DEFAULT_EFFORT_VALUE = 'default';

// ---------------------------

//----------------- FILE UPLOAD LIMITS ------------

/** Largest single file the upload endpoint accepts, in megabytes. Source of truth for the two derived limits below. */
export const MAX_FILE_UPLOAD_SIZE_MB = 200;

/** `MAX_FILE_UPLOAD_SIZE_MB` in bytes, for comparing against `File.size` before uploading. */
export const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;

/** Human-readable form of the size limit, shown in the file tree header and in upload errors. */
export const MAX_FILE_UPLOAD_SIZE_LABEL = `${MAX_FILE_UPLOAD_SIZE_MB}MB`;

// ---------------------------

//----------------- GIT CHANGE GROUPS ------------

/** Shape of one entry in `FILE_STATUS_GROUPS`; only that constant needs it. */
type GitStatusGroupEntry = {
  key: GitStatusFileGroup;
  status: FileStatusCode;
};

/**
 * The order in which the git changes view groups files, and the status code each group holds.
 * Both the change list and the status-grouping helper iterate it so the two stay aligned.
 */
export const FILE_STATUS_GROUPS: GitStatusGroupEntry[] = [
  { key: 'modified', status: 'M' },
  { key: 'added', status: 'A' },
  { key: 'deleted', status: 'D' },
  { key: 'untracked', status: 'U' },
];

// ---------------------------

//----------------- MCP SERVER CAPABILITIES ------------

/** Display name for each provider that can host MCP servers, used in headings and buttons. */
export const MCP_PROVIDER_NAMES: Record<McpProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  agy: 'Antigravity',
};

/**
 * Scopes each provider can install an MCP server into; drives the scope selector and validation.
 * Antigravity has none: CloudCLI does not manage its MCP servers (the settings dialog shows it no MCP tab).
 */
export const MCP_SUPPORTED_SCOPES: Record<McpProvider, McpScope[]> = {
  claude: ['user', 'project', 'local'],
  cursor: ['user', 'project'],
  codex: ['user', 'project'],
  opencode: ['user', 'project'],
  agy: [],
};

/** Transports each provider can talk to an MCP server over; drives the transport selector and validation. */
export const MCP_SUPPORTED_TRANSPORTS: Record<McpProvider, McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  cursor: ['stdio', 'http'],
  codex: ['stdio', 'http'],
  opencode: ['stdio', 'http'],
  agy: [],
};

/** Transports offered when configuring a global (provider-agnostic) MCP server. */
export const MCP_GLOBAL_SUPPORTED_TRANSPORTS: McpTransport[] = ['stdio', 'http'];

/** Whether a provider honours an MCP server's working-directory setting; the form hides the field when it does not. */
export const MCP_SUPPORTS_WORKING_DIRECTORY: Record<McpProvider, boolean> = {
  claude: false,
  cursor: false,
  codex: true,
  opencode: false,
  agy: false,
};

// ---------------------------

//----------------- QUICK SETTINGS PANEL ROWS ------------

/**
 * Class list for one row in the quick settings panel. Shared so plain rows and the clickable
 * toggle row (which appends `cursor-pointer`) stay visually identical.
 */
export const SETTING_ROW_CLASS =
  'flex items-center justify-between p-3 rounded-lg bg-muted/60 hover:bg-accent transition-colors border border-transparent hover:border-border';

// ---------------------------

//----------------- TERMINAL TIMING ------------

/**
 * Delay before the terminal is measured and fitted after it is attached. Gives the browser one
 * layout pass so the initial fit and the resize message sent to the backend use real dimensions.
 */
export const TERMINAL_INIT_DELAY_MS = 100;

// ---------------------------

//----------------- CODE EDITOR DISPLAY SETTINGS ------------

/**
 * The four localStorage keys the code-editor display settings used to live
 * under, kept only so `userSettings` can migrate an existing install onto the
 * stored `codeEditorSettings` preference. Nothing writes them any more.
 */
export const CODE_EDITOR_STORAGE_KEYS = {
  wordWrap: 'codeEditorWordWrap',
  showMinimap: 'codeEditorShowMinimap',
  lineNumbers: 'codeEditorLineNumbers',
  fontSize: 'codeEditorFontSize',
} as const;

/**
 * Values applied when a code-editor setting has never been written. These are
 * the editor's own historical defaults; the settings dialog used to carry its
 * own copy with a different fontSize, so merely opening it rewrote the user's
 * editor font.
 *
 * Code files do not wrap by default, Markdown and plain-text files do.
 * `textWordWrap` is a separate key rather than a new `wordWrap` default because
 * many users already have `wordWrap: false` stored explicitly; it has no legacy
 * localStorage key to migrate.
 */
export const CODE_EDITOR_DEFAULTS = {
  wordWrap: false,
  textWordWrap: true,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '12',
} as const;


// ---------------------------

//----------------- PROVIDER TOOL SETTINGS STORAGE ------------

/**
 * Per-provider preference key holding that provider's tool-permission
 * settings, sent with every `chat.send`.
 *
 * `opencode` and `agy` intentionally map to their own keys even though no
 * settings UI writes them yet: without the entry the lookup would fall through
 * to Claude's key and those sessions would silently inherit Claude's
 * `skipPermissions`.
 */
export const PROVIDER_PERMISSION_PREFERENCE_KEYS: Record<LLMProvider, UserPreferenceKey> = {
  claude: 'claudePermissions',
  cursor: 'cursorPermissions',
  codex: 'codexPermissions',
  opencode: 'opencodePermissions',
  agy: 'agyPermissions',
};

// ---------------------------

//----------------- PROVIDER NAMES ------------

/** Each provider's name as lists show it beside a session, the same in every language (the command palette). */
export const PROVIDER_DISPLAY_NAMES: Record<LLMProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  agy: 'Antigravity',
};

// ---------------------------

//----------------- PROVIDER SIGN-IN ------------

/**
 * Providers that CloudCLI cannot sign in from the browser, mapped to the CLI
 * command the user runs once in their own terminal to sign in. The onboarding
 * and settings account views show this command as a hint in place of the Login
 * button, and the provider-auth login modal refuses to open its embedded login
 * shell for these providers.
 */
export const PROVIDER_TERMINAL_SIGN_IN_COMMANDS: Partial<Record<LLMProvider, string>> = {
  agy: 'agy',
};

// ---------------------------

//----------------- KEYBOARD SHORTCUTS ------------

/**
 * Layers that own the Escape key while they are open: menus, modal dialogs and anything carrying
 * the app's `data-escape-layer` marker. Keyboard handlers underneath step aside while one matches:
 * code-editor's useEditorKeyboardShortcuts (Escape closing the editor), project-workspace's
 * useWorkspaceShortcuts (the split, pane focus and full-screen shortcuts, which only step aside for a
 * layer that owns the whole keyboard: a non-modal dialog such as the immersive sidebar drawer owns
 * Escape alone), project-workspace's ProjectSidebarRegion (Escape closing that drawer, which skips
 * its own marker) and chat's ChatInterface (Escape stopping the running turn).
 */
export const ESCAPE_LAYER_SELECTOR = '[data-escape-layer], [aria-modal="true"], [role="menu"]';

/**
 * Split or merge the workspace. Like the shortcuts below it is written in formatShortcut's tokens:
 * project-workspace's useWorkspaceShortcuts matches the keys it names (by physical key), and its tab
 * bar tooltips and empty-pane hints show them, so the keys and what the hints say change together.
 */
export const WORKSPACE_SPLIT_SHORTCUT = ['mod', '\\'] as const;

/** Focus the left pane while split (see WORKSPACE_SPLIT_SHORTCUT for who reads it). */
export const WORKSPACE_FOCUS_LEFT_PANE_SHORTCUT = ['mod', '1'] as const;

/** Focus the right pane while split (see WORKSPACE_SPLIT_SHORTCUT for who reads it). */
export const WORKSPACE_FOCUS_RIGHT_PANE_SHORTCUT = ['mod', '2'] as const;

/** Toggle full screen (see WORKSPACE_SPLIT_SHORTCUT for who reads it). */
export const WORKSPACE_FULLSCREEN_SHORTCUT = ['mod', 'shift', 'enter'] as const;

/**
 * The browser's reload key, which refreshes the whole workspace in place while the document is in browser
 * full screen (a page reload would leave it); Mod+R does the same. project-workspace's useWorkspaceShortcuts
 * catches both, and the Refresh all tooltip names this one.
 */
export const WORKSPACE_FULLSCREEN_REFRESH_SHORTCUT = ['F5'] as const;

// ---------------------------

//----------------- WORKSPACE PANES ------------

/** Both sides of the split workspace, left first: the order panes render and get listed in. */
export const WORKSPACE_PANE_SIDES: readonly WorkspacePaneSide[] = ['left', 'right'];

/**
 * Separators of the string keys project-workspace builds to keep derived maps stable (tab placements in
 * useWorkspaceNavigation, tab labels in ProjectMainRegion): between entries, and between the fields of
 * one entry. Session ids, titles and project names never contain these control characters.
 */
export const WORKSPACE_KEY_ENTRY_SEPARATOR = '\u0000';

/** See WORKSPACE_KEY_ENTRY_SEPARATOR: separates the fields of one entry. */
export const WORKSPACE_KEY_FIELD_SEPARATOR = '\u0001';

/** Narrowest a pane may get; two panes need 2x this + PANE_SPLITTER_WIDTH_PX, else only the focused pane shows. */
export const PANE_MIN_WIDTH_PX = 360;

/** Hit width of the divider between the two panes. */
export const PANE_SPLITTER_WIDTH_PX = 6;

/** Left share after Split and after a double-click on the divider. */
export const WORKSPACE_SPLIT_RATIO_DEFAULT = 0.5;

/** Lower bound of the left share; pixel minimums apply on top. */
export const WORKSPACE_SPLIT_RATIO_MIN = 0.2;

/** Upper bound of the left share; pixel minimums apply on top. */
export const WORKSPACE_SPLIT_RATIO_MAX = 0.8;

/** Pane layout key in sessionStorage (this browser tab, authoritative) and localStorage (seed for new pages); removed on logout. */
export const WORKSPACE_LAYOUT_STORAGE_KEY = 'workspace-layout';

/**
 * What a pane component registers with the command palette while the operations belong to someone else:
 * project-workspace's WorkspacePane while it shows content (its WorkspaceMain and chat register them then)
 * and its WorkspaceMain while the pane is unfocused (the focused pane's register them). No operations, and
 * one object for every render, so the registration effects do not rerun.
 */
export const NO_PALETTE_OPS = Object.freeze({});

/**
 * effectAllowed of a dragged pane tab, set by project-workspace's PaneTabBar. Drop targets (PaneTabBar's
 * strip, PaneDropOverlay's zones) read it during dragover, where the payload itself is unreadable, to
 * tell a tab (moves, Alt copies) from a sidebar row.
 */
export const PANE_TAB_DRAG_EFFECT = 'copyMove';

// ---------------------------

//----------------- DOCKED CODE EDITOR ------------

/** Narrowest the content beside a docked code editor (the file tree, the chat) gets; a pane without room for both expands or pops out the editor. */
export const EDITOR_SIDE_CONTENT_MIN_WIDTH_PX = 200;

/** Narrowest a docked code editor gets, not counting the divider in front of it. */
export const EDITOR_PANEL_MIN_WIDTH_PX = 280;

/** Layout width of the divider in front of a docked code editor (Tailwind w-1). */
export const EDITOR_DIVIDER_WIDTH_PX = 4;

/** The file tree's share of the pane beside a docked editor in the Files view: before the first drag, for a stored value that does not parse, and after Home or a double-click on the divider. */
export const FILES_TREE_RATIO_DEFAULT = 0.4;

// ---------------------------

//----------------- CHAT TRANSCRIPT ROWS ------------

/**
 * Class on the always-mounted wrapper of every transcript row that opens a turn (a user message that was
 * neither inserted mid-turn nor a local command; see isTurnOpener). Set by chat's ChatMessagesPane through
 * LazyMessageRow, read by chat's usePinnedQuestion, which finds these wrappers in document order to tell
 * which turn sits at the top of the transcript. Kept off `.chat-message`, so the scroll restore never takes
 * a wrapper for a row.
 */
export const TURN_OPENER_ROW_CLASS = 'chat-turn-opener-row';
