import React from 'react';

import { Markdown } from '@/modules/chat/transcript/Markdown';

type MarkdownContentProps = {
  content: string;
  className?: string;
};

/**
 * Renders markdown content with proper styling
 * Used by: exit_plan_mode, long text results, etc.
 *
 * Rendered by chat's ToolRenderer and PlanDisplay as the markdown body of a
 * tool result, and by SubagentPanel and WorkflowPanel for an agent's answer.
 * What it shows is written by a model or a tool, so it is laid out by its own
 * first letter (dir="auto"), as the assistant's reply is: an English plan reads
 * left to right in a right-to-left interface, its full stops at the end.
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = 'mt-1 prose prose-sm max-w-none dark:prose-invert'
}) => {
  return (
    <Markdown dir="auto" className={className}>
      {content}
    </Markdown>
  );
};
