import { useTranslation } from 'react-i18next';

import type { FileTreeDetailedColumn } from '@/shared/types';

type FileTreeDetailedColumnsProps = {
  /** The metadata columns that fit, in order; the name column always shows. */
  columns: readonly FileTreeDetailedColumn[];
  /** The grid template every row uses too, so the labels sit over their values. */
  gridTemplate: string;
};

const COLUMN_LABEL_KEYS: Record<FileTreeDetailedColumn, string> = {
  size: 'fileTree.size',
  modified: 'fileTree.modified',
  permissions: 'fileTree.permissions',
};

/**
 * Rendered by FileTree in detailed view mode, first in the scroller and stuck to its top, to label the name
 * column and the metadata columns that fit. Its box matches a top-level row's (2px border, 4px left and 8px
 * right padding), so the fixed metadata tracks line up with every row's.
 */
export default function FileTreeDetailedColumns({ columns, gridTemplate }: FileTreeDetailedColumnsProps) {
  const { t } = useTranslation();

  return (
    <div className="sticky top-0 z-10 mb-0.5 border-b border-border bg-background pb-1 pt-0.5">
      <div
        className="grid gap-x-2 border-s-2 border-transparent pe-2 ps-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div data-column="name" className="truncate">{t('fileTree.name')}</div>
        {columns.map((column) => (
          <div key={column} data-column={column} className="truncate">{t(COLUMN_LABEL_KEYS[column])}</div>
        ))}
      </div>
    </div>
  );
}
