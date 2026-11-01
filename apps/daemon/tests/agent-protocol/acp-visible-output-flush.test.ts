import { describe, expect, it } from 'vitest';
import { countRenderableQuestionForms } from '../../src/question-form-detect.js';
import { acpTelemetryToolCallId } from '../../src/agent-protocol/acp/updates.js';
import {
  completedTodoUpdates, runMemoryAcpTurn, safeObservation, textUpdate, TODO_ID, TODO_INPUT,
  type AcpTurnObservation,
} from './acp-memory-peer.js';

function expectClean(turn: AcpTurnObservation, text: string) {
  const evidence = safeObservation(turn);
  expect.soft(turn.visibleText, evidence).toBe(text);
  expect.soft(turn.errors, evidence).toEqual([]);
  expect.soft(turn.fatal, evidence).toBe(false);
  expect.soft(turn.completed, evidence).toBe(true);
  expect.soft(turn.terminals, evidence).toEqual(['completed']);
  expect.soft(turn.promptCompleteCount, evidence).toBe(1);
}

function expectHandshake(turn: AcpTurnObservation, prompt: string) {
  expect(turn.requestMethods).toEqual(['initialize', 'session/new', 'session/prompt']);
  expect(turn.sentPrompt).toEqual([{ type: 'text', text: prompt }]);
  expect(turn.beforePromptResult.terminals).toEqual([]);
  expect(turn.beforePromptResult.completed).toBe(false);
}

// Same closed renderable body as the existing daemon question-form tests.
const FORM = '<question-form id="q">{"questions":[{"id":"surface","label":"Which surface?"}]}</question-form>';

describe('ACP consumes legitimate residual text before judging visible output', () => {
  it('preserves the explicitly requested literal < at completion', async () => {
    const prompt = 'Return exactly the single character < and nothing else.';
    const turn = await runMemoryAcpTurn({ prompt, updates: [textUpdate('<')] });
    expectHandshake(turn, prompt);
    expect(turn.beforePromptResult.visibleText).toBe('');
    expect(turn.tools).toEqual([]);
    expectClean(turn, '<');
  });

  for (const [mode, chunks] of [
    ['whole', [FORM]],
    ['protocol chunks', ['<question-', 'form id="q">', '{"questions":[{"id":"surface","label":"Which surface?"}]}', '</question-', 'form>']],
    ['trailing newline', [`${FORM}\n`]],
  ] as const) {
    it(`accepts a legitimate question-form with ${mode}`, async () => {
      expect(countRenderableQuestionForms(FORM)).toBe(1);
      expect(chunks.join('')).toBe(mode === 'trailing newline' ? `${FORM}\n` : FORM);
      const prompt = 'Ask which surface to design before generating anything.';
      const turn = await runMemoryAcpTurn({ prompt, updates: chunks.map(textUpdate) });
      expectHandshake(turn, prompt);
      expect(turn.tools).toEqual([]);
      expectClean(turn, chunks.join(''));
      expect.soft(countRenderableQuestionForms(turn.visibleText), safeObservation(turn)).toBe(1);
    });
  }

  it('allows a normal answer without tools or an artifact requirement', async () => {
    const prompt = 'What is two plus two? Answer briefly; do not create any files.';
    const turn = await runMemoryAcpTurn({ prompt, updates: [textUpdate('Four.')] });
    expectHandshake(turn, prompt);
    expect(turn.tools).toEqual([]);
    expectClean(turn, 'Four.');
  });

  it('keeps an upstream-completed TodoWrite and literal pseudo-tag examples', async () => {
    const literal = 'Example: `<od-todowrite>literal</od-todowrite>`.\n\n```xml\n<od-todowrite>code only</od-todowrite>\n```\n';
    const prompt = 'Update the plan, then show the requested protocol spelling as code.';
    const turn = await runMemoryAcpTurn({
      prompt, updates: [...completedTodoUpdates(), textUpdate(literal)],
    });
    expectHandshake(turn, prompt);
    expect(turn.inputCompletedToolFrames).toBe(1);
    expect(turn.tools).toEqual([
      expect.objectContaining({ origin: 'agent_frame', type: 'tool_use', id: acpTelemetryToolCallId(TODO_ID), name: 'TodoWrite', input: TODO_INPUT }),
      expect.objectContaining({ origin: 'agent_frame', type: 'tool_result', id: acpTelemetryToolCallId(TODO_ID), content: 'Todo list updated', isError: false }),
    ]);
    expect(turn.tools.some((tool) => tool.origin === 'host_flush')).toBe(false);
    expectClean(turn, literal);
  });

  it('keeps the existing generic ACP empty completion policy', async () => {
    const prompt = 'Use the configured agent.';
    const turn = await runMemoryAcpTurn({ prompt, updates: [], outputTokens: 0 });
    expectHandshake(turn, prompt);
    expect(turn.tools).toEqual([]);
    expectClean(turn, '');
  });

  it('does not count thought-only activity as visible output or a concrete tool', async () => {
    const turn = await runMemoryAcpTurn({
      prompt: 'Generate the requested video.',
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning the work.' } }],
    });
    expect(turn.visibleText).toBe('');
    expect(turn.tools).toEqual([]);
    expectClean(turn, '');
  });
});
