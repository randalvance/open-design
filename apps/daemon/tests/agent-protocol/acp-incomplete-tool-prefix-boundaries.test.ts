import { describe, expect, it } from 'vitest';
import { createToolCallTextSuppressor } from '../../src/artifacts/text-suppression.js';
import { countRenderableQuestionForms } from '../../src/question-form-detect.js';
import { runMemoryAcpTurn, safeObservation, textUpdate } from './acp-memory-peer.js';

// These pin the existing protocol boundary; they do not classify unknown od-*
// names or generation intent.
const KNOWN_PREFIXES = [
  ['uppercase tool name', '<TOOL_CALL'],
  ['tool name with surrounding whitespace', '< \ttool_call \t'],
  ['tool opener with an attribute', '<tool_call name="Write"'],
  ['mixed-case edit name', '<EdIt'],
  ['edit name with surrounding whitespace', '< \tedit \t'],
] as const;

// These are explicitly requested literal replies. In particular, attributes
// are recognized on tool_call but are not part of the existing edit wrapper.
const LITERAL_PREFIXES = [
  ['plural lookalike', '<tool_calls'],
  ['longer edit lookalike', '<editors'],
  ['ambiguous short spelling', '<t'],
  ['edit spelling with an unsupported attribute', '<edit name="Write"'],
] as const;

function expectClean(turn: Awaited<ReturnType<typeof runMemoryAcpTurn>>, text: string) {
  const evidence = safeObservation(turn);
  expect.soft(turn.visibleText, evidence).toBe(text);
  expect.soft(turn.tools, evidence).toEqual([]);
  expect.soft(turn.errors, evidence).toEqual([]);
  expect.soft(turn.fatal, evidence).toBe(false);
  expect.soft(turn.completed, evidence).toBe(true);
  expect.soft(turn.terminals, evidence).toEqual(['completed']);
  expect.soft(turn.promptCompleteCount, evidence).toBe(1);
}

const FORM = '<question-form id="q-prefix">{"questions":[{"id":"spelling","label":"Keep <tool_calls or <editors as literal spelling?"}]}</question-form>';

describe('ACP completion keeps the established tool-prefix boundary', () => {
  for (const [label, prefix] of LITERAL_PREFIXES) {
    it(`returns the requested ${label} without treating it as an executed tool`, async () => {
      const prompt = `Return exactly these characters as plain text, with no explanation: ${prefix}`;
      const turn = await runMemoryAcpTurn({ prompt, updates: [textUpdate(prefix)] });
      expect(turn.sentPrompt).toEqual([{ type: 'text', text: prompt }]);
      expect(turn.beforePromptResult.visibleText).toBe('');
      expect(turn.beforePromptResult.terminals).toEqual([]);
      expectClean(turn, prefix);
    });
  }

  // Existing generic ACP completion must continue to use the ordinary flush
  // contract, including exact internal-looking prefixes requested as literals.
  for (const prefix of ['<tool_call', '<edit', '<tool_call name="Write"', '<t']) {
    it(`generic ACP preserves the existing literal completion for ${prefix}`, async () => {
      const prompt = `Return exactly these characters as plain text: ${prefix}`;
      const turn = await runMemoryAcpTurn({ prompt, updates: [textUpdate(prefix)] });
      expect(turn.requestMethods).toEqual(['initialize', 'session/new', 'session/prompt']);
      expect(turn.beforePromptResult.visibleText).toBe('');
      expectClean(turn, prefix);
    });
  }

  it('ordinary flush retains unfinished spellings once and leaves no residual output', () => {
    // Public suppressor API guard: no private predicate is called or reproduced.
    for (const prefix of ['<tool_call', '<edit', ...KNOWN_PREFIXES.map(([, text]) => text), ...LITERAL_PREFIXES.map(([, text]) => text)]) {
      const suppressor = createToolCallTextSuppressor();
      const visible = suppressor.strip(prefix);
      expect(visible + suppressor.flush(), prefix).toBe(prefix);
      expect(suppressor.flush(), prefix).toBe('');
    }
  });

  for (const [label, chunks] of [
    ['whole', [FORM]],
    ['protocol fragments', ['<question-', 'form id="q-prefix">', '{"questions":[{"id":"spelling","label":"Keep <tool_calls or <editors as literal spelling?"}]}', '</question-', 'form>']],
  ] as const) {
    it(`preserves a legitimate question-form containing literal lookalikes (${label})`, async () => {
      expect(chunks.join('')).toBe(FORM);
      expect(countRenderableQuestionForms(FORM)).toBe(1);
      const turn = await runMemoryAcpTurn({
        prompt: 'Ask which literal spelling the user wants before doing further work.',
        updates: chunks.map(textUpdate),
      });
      expectClean(turn, FORM);
      expect(countRenderableQuestionForms(turn.visibleText), safeObservation(turn)).toBe(1);
    });
  }
});
