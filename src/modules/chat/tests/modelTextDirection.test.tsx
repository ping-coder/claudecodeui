import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import { BashCommandDisplay } from '@/modules/chat/tools/BashCommandDisplay';
import { QuestionAnswerContent } from '@/modules/chat/tools/ContentRenderers/QuestionAnswerContent';
import { TextContent } from '@/modules/chat/tools/ContentRenderers/TextContent';
import TodoList from '@/modules/chat/tools/ContentRenderers/TodoList';
import { PlanDisplay } from '@/modules/chat/tools/PlanDisplay';
import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import { ToolErrorDisplay } from '@/modules/chat/tools/ToolErrorDisplay';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { WorkflowPanel } from '@/modules/chat/tools/WorkflowPanel';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, PendingPermissionRequest, Question } from '@/shared/types';

/**
 * Text a model or a tool wrote (a tool's output, thinking, a plan, a subagent's task, notes and
 * answer, a question and its options) is laid out by its own first letter, as the assistant's
 * reply is (dir="auto"). Laid out in a right-to-left interface's direction, an English sentence
 * drew its full stop at its left end. The interface's own words around it keep the interface's
 * direction, and nothing depends on the language, so English reads as before.
 */

const createDiff = createCachedDiffCalculator();

/**
 * The `dir` of the nearest element around `text` that has one, inside the rendered tree; '' when
 * none does. Read as a string, so a failing assertion never inspects a DOM node.
 */
const dirAround = (text: string): string => {
  const holders = [...document.body.querySelectorAll('*')].filter((element) => (element.textContent ?? '').includes(text));
  const innermost = holders.find((element) => ![...element.children].some((child) => (child.textContent ?? '').includes(text)));
  assert.equal(Boolean(innermost), true, `"${text}" is on the page`);
  for (let node: Element | null = innermost ?? null; node && node !== document.body; node = node.parentElement) {
    if (node.hasAttribute('dir')) {
      return node.getAttribute('dir') ?? '';
    }
  }
  return '';
};

beforeEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('he');
  });
});

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

describe('a tool\'s output', () => {
  it('reads by its own direction as plain text: a search, a fetched page, an MCP tool\'s answer', () => {
    render(
      <>
        <ToolRenderer toolName="WebSearch" toolInput={JSON.stringify({ query: 'q' })} toolResult={{ content: 'Web search results for query: "react-dropzone".' }} mode="result" />
        <ToolRenderer toolName="WebFetch" toolInput={JSON.stringify({ url: 'https://example.com' })} toolResult={{ content: 'The upload API emits progress events.' }} mode="result" />
        <ToolRenderer toolName="mcp__github__create_issue" toolInput={JSON.stringify({ title: 't' })} toolResult={{ content: 'Created issue #42.' }} mode="result" />
      </>,
    );
    assert.equal(dirAround('Web search results for query: "react-dropzone".'), 'auto');
    assert.equal(dirAround('The upload API emits progress events.'), 'auto');
    assert.equal(dirAround('Created issue #42.'), 'auto');
    // The card's own title stays in the interface's direction.
    assert.equal(dirAround(i18n.t('chat:tools.titles.searchResults')), '');
  });

  it('leaves code and JSON as they were, and a failed tool\'s message reads by its own direction', () => {
    render(
      <>
        <TextContent content="const a = 1;" format="code" />
        <TextContent content='{"a":1}' format="json" />
        <ToolErrorDisplay label="Error" content="File does not exist." />
      </>,
    );
    assert.equal(dirAround('const a = 1;'), '');
    assert.equal(dirAround('"a": 1'), '');
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    assert.equal(dirAround('File does not exist.'), 'auto');
  });
});

describe('thinking', () => {
  it('reads by its own direction; the toggle and the copy row keep the interface\'s', () => {
    const message = {
      type: 'assistant',
      isThinking: true,
      content: 'The user wants per-file progress.',
      timestamp: new Date('2026-10-29T10:00:00.000Z'),
    } as ChatMessage;
    render(
      <UiPreferencesProvider>
        <MessageComponent message={message} prevMessage={null} createDiff={createDiff} provider="claude" showThinking />
      </UiPreferencesProvider>,
    );
    assert.equal(dirAround('The user wants per-file progress.'), 'auto');
    assert.equal(dirAround(i18n.t('chat:thinking.thoughtBriefly')), '');
    assert.equal(dirAround(i18n.t('chat:copyMessage.markdownShort')), '');
  });
});

describe('a plan', () => {
  it('reads by its own direction under the card\'s own title', () => {
    render(<PlanDisplay title="Implementation plan" content={'# Upload rework\n\n1. Keep react-dropzone and report progress per file.'} defaultOpen toolName="ExitPlanMode" />);
    assert.equal(dirAround('Keep react-dropzone and report progress per file.'), 'auto');
    assert.equal(dirAround('Upload rework'), 'auto');
    assert.equal(dirAround('Implementation plan'), '');
  });
});

describe('a subagent', () => {
  it('reads its task, its notes and its answer by their own direction; the labels keep the interface\'s', () => {
    render(
      <SubagentPanel
        toolInput={JSON.stringify({ subagent_type: 'Explore', description: 'Review the upload hook.', prompt: 'Read src/greet.js and list what blocks progress.' })}
        toolResult={{ content: 'Found two problems.', isError: false }}
        activity={[
          { kind: 'thinking', content: 'Start with the hook, then the helpers.' },
          { kind: 'text', content: 'Reading the two files.' },
        ]}
        createDiff={createDiff}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    assert.equal(dirAround('Read src/greet.js and list what blocks progress.'), 'auto');
    assert.equal(dirAround('Start with the hook, then the helpers.'), 'auto');
    assert.equal(dirAround('Reading the two files.'), 'auto');
    assert.equal(dirAround('Found two problems.'), 'auto');
    assert.equal(dirAround(i18n.t('chat:subagent.task')), '');
    assert.equal(dirAround(i18n.t('common:workflow.result')), '');
    // The one-line description beside the agent's name keeps its own order and is cut at its end.
    const description = screen.getByText('Review the upload hook.');
    assert.equal(description.classList.contains('bidi-auto'), true);
  });
});

describe('a workflow', () => {
  it('reads an agent\'s result preview and the run\'s result by their own direction', () => {
    render(
      <WorkflowPanel
        toolInput={JSON.stringify({ script: 'export const meta = { name: \'audit\' }', description: 'Audit' })}
        toolResult={{ content: 'The audit found three large hooks.', isError: false }}
        workflow={{
          runId: 'wf_1',
          name: 'audit',
          status: 'completed',
          agents: [{ id: 'a1', label: 'audit:chat', status: 'completed' }],
          agentCounts: { total: 1, completed: 1, failed: 0, running: 0, stopped: 0 },
        }}
        taskStatus={{ status: 'completed', agents: [{ index: 0, label: 'audit:chat', agentId: 'a1', state: 'done', resultPreview: 'Three large hooks carry most of the module.' }] }}
        createDiff={createDiff}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    assert.equal(dirAround('Three large hooks carry most of the module.'), 'auto');
    assert.equal(dirAround('The audit found three large hooks.'), 'auto');
    // The preview's row keeps the interface's direction, so its indent stays on the start side.
    const previewRow = [...document.body.querySelectorAll('div')].find((element) => element.classList.contains('ps-[30px]') && (element.textContent ?? '').includes('Three large hooks'));
    assert.equal(Boolean(previewRow), true);
    assert.equal(previewRow?.hasAttribute('dir') ?? true, false);
  });
});

describe('a card\'s title, a checklist, a command\'s note and a task\'s report', () => {
  it('reads an answered question\'s "header — answer" title by its own order', () => {
    render(
      <ToolRenderer
        toolName="AskUserQuestion"
        toolInput={JSON.stringify({
          questions: [{ question: 'How should uploads work?', header: 'Approach', multiSelect: false, options: [{ label: 'Use COPY.', description: '' }] }],
          answers: { 'How should uploads work?': 'Use COPY.' },
        })}
        mode="input"
      />,
    );
    const title = screen.getByText('Approach — Use COPY.');
    assert.equal(title.classList.contains('bidi-auto'), true);
  });

  it('reads each checklist item by its own direction', () => {
    render(<TodoList todos={[{ id: '1', content: 'Update the README.', status: 'pending' }, { id: '2', content: 'Ship it.', status: 'completed' }]} />);
    assert.equal(dirAround('Update the README.'), 'auto');
    assert.equal(dirAround('Ship it.'), 'auto');
  });

  it('reads a command\'s note by its own direction, collapsed and opened, and keeps the indent on the row', () => {
    render(<BashCommandDisplay command="ls -la" description="List the files." output="a" />);
    assert.equal(dirAround('List the files.'), 'auto');
    const noteRow = [...document.body.querySelectorAll('div')].find((element) => element.classList.contains('ps-[2.4rem]'));
    assert.equal(noteRow?.hasAttribute('dir') ?? true, false);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    assert.equal(dirAround('List the files.'), 'auto');
  });

  it('reads a background task\'s report by its own direction', () => {
    const message = {
      type: 'assistant',
      isTaskNotification: true,
      taskNotificationStatus: 'completed',
      content: 'Background command finished.',
      timestamp: new Date('2026-10-29T10:00:00.000Z'),
    } as ChatMessage;
    render(
      <UiPreferencesProvider>
        <MessageComponent message={message} prevMessage={null} createDiff={createDiff} provider="claude" />
      </UiPreferencesProvider>,
    );
    assert.equal(dirAround('Background command finished.'), 'auto');
  });
});

const QUESTIONS: Question[] = [
  {
    question: 'Which upload library should we keep?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'react-dropzone', description: 'Keep it and add per-file progress.' },
      { label: 'Uppy', description: 'Swap it in for its progress bar.' },
    ],
  },
];

describe('an answered question', () => {
  it('reads the question, the answers and the options by their own direction', () => {
    render(<QuestionAnswerContent questions={QUESTIONS} answers={{ 'Which upload library should we keep?': 'Something else.' }} />);
    assert.equal(dirAround('Which upload library should we keep?'), 'auto');
    assert.equal(dirAround('Library'), 'auto');
    assert.equal(dirAround('Something else.'), 'auto');
    // The chip's "custom" tag is the interface's word.
    assert.equal(dirAround(i18n.t('chat:askQuestion.custom')), '');

    // Opened, the options are listed and the answer stands on a row of its own.
    fireEvent.click(screen.getByRole('button'));
    assert.equal(dirAround('Keep it and add per-file progress.'), 'auto');
    assert.equal(dirAround('Uppy'), 'auto');
    assert.equal(dirAround('Something else.'), 'auto');
  });
});

describe('the question panel', () => {
  it('reads the question and each option by their own direction; "Other" keeps the interface\'s', () => {
    const request = {
      requestId: 'ask-1',
      toolName: 'AskUserQuestion',
      input: { questions: QUESTIONS },
    } as PendingPermissionRequest;
    render(<AskUserQuestionPanel request={request} onDecision={() => undefined} />);
    assert.equal(dirAround('Which upload library should we keep?'), 'auto');
    assert.equal(dirAround('react-dropzone'), 'auto');
    assert.equal(dirAround('Swap it in for its progress bar.'), 'auto');
    assert.equal(dirAround('Library'), 'auto');
    assert.equal(dirAround(i18n.t('chat:askQuestion.other')), '');
    assert.equal(dirAround(i18n.t('chat:askQuestion.needsInput')), '');
  });
});
