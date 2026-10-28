import { ClipboardCheck, Folder, GitBranch, MessageSquare, MonitorPlay, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMemo } from 'react';

import { usePlugins } from '@/modules/plugins';
import type { AppTab } from '@/shared/types';

type BuiltInView = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type PluginView = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

const BASE_VIEWS: BuiltInView[] = [
  { kind: 'builtin', id: 'chat', labelKey: 'tabs.chat', icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git', labelKey: 'tabs.git', icon: GitBranch },
];

const BROWSER_VIEW: BuiltInView = { kind: 'builtin', id: 'browser', labelKey: 'tabs.browser', icon: MonitorPlay };

const TASKS_VIEW: BuiltInView = { kind: 'builtin', id: 'tasks', labelKey: 'tabs.tasks', icon: ClipboardCheck };

type UseWorkspaceViewsArgs = {
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
};

/**
 * The views a pane can switch between: the built-in ones (Browser and Tasks only while enabled), then
 * every enabled plugin. WorkspaceTabs draws them as the view bar; WorkspacePane counts them, since the
 * room a labelled view bar needs decides where it goes.
 */
export function useWorkspaceViews({ shouldShowTasksTab, shouldShowBrowserTab }: UseWorkspaceViewsArgs) {
  const { plugins } = usePlugins();

  const builtInViews = useMemo<BuiltInView[]>(() => [
    ...BASE_VIEWS,
    ...(shouldShowBrowserTab ? [BROWSER_VIEW] : []),
    ...(shouldShowTasksTab ? [TASKS_VIEW] : []),
  ], [shouldShowBrowserTab, shouldShowTasksTab]);

  const pluginViews = useMemo<PluginView[]>(() => plugins
    .filter((plugin) => plugin.enabled)
    .map((plugin) => ({
      kind: 'plugin',
      id: `plugin:${plugin.name}` as AppTab,
      label: plugin.displayName,
      pluginName: plugin.name,
      iconFile: plugin.icon,
    })), [plugins]);

  return { builtInViews, pluginViews };
}
