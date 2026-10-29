import { Children } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { stripBidiIsolates } from '@/shared/direction';

const withoutIsolates = (node: ReactNode): ReactNode => (typeof node === 'string' ? stripBidiIsolates(node) : node);

/**
 * The `<code>` of a Trans `components` map (`Run <code>{{command}}</code> once`), drawn without the
 * isolates a right-to-left language wraps the value in (modules/i18n/bidi.ts). index.css already
 * isolates `[dir="rtl"] code` left to right, so the value keeps its order on screen; without the
 * characters a selection of it carries none either. Linux's middle-click paste reads the selection
 * directly (no copy event, so installIsolateFreeCopy never sees it), and `claude login` pasted into
 * a terminal would start with U+2068. Used by onboarding's AgentConnectionCard, the agents settings'
 * AccountContent and chat's CommandResultModal.
 */
export function IsolateFreeCode({ children, ...props }: ComponentPropsWithoutRef<'code'>) {
  return <code {...props}>{Children.map(children, withoutIsolates)}</code>;
}
