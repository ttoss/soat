// Pure helpers for the memory merge-consolidation path. Kept free of DB/LLM
// imports so the prompt shape and the fallback rule are unit-testable without a
// database or a model. The LLM boundary lives in `memoryConsolidationCompletion.ts`.

const CONSOLIDATION_INSTRUCTIONS = [
  'You maintain a memory of atomic facts.',
  'Merge the existing fact and the new fact into a SINGLE, self-contained fact.',
  'Keep it to one concise sentence and preserve the specific details from both.',
  'If they contradict, prefer the information in the new fact.',
  'Respond with only the merged fact text — no quotes, labels, or preamble.',
].join('\n');

/**
 * Builds the completion prompt that consolidates an existing entry and an
 * incoming fact into one atomic fact. Contradictions resolve in favour of the
 * incoming fact.
 */
export const buildConsolidationPrompt = (args: {
  existing: string;
  incoming: string;
}): string => {
  return [
    CONSOLIDATION_INSTRUCTIONS,
    '',
    'Existing fact:',
    args.existing,
    '',
    'New fact:',
    args.incoming,
  ].join('\n');
};

/**
 * Chooses the content to persist after a consolidation attempt: the trimmed
 * consolidated text when the model returned something usable, otherwise the
 * concatenation fallback. A blank completion must never blow away the merge.
 */
export const pickMergedContent = (args: {
  consolidated: string;
  fallback: string;
}): string => {
  const trimmed = args.consolidated.trim();
  return trimmed.length > 0 ? trimmed : args.fallback;
};
