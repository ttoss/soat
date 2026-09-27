import type { DeciderQuestion, DeciderQuestions } from './deciderQuestions';

/**
 * The message an agent-backed decision sends: the questions with their
 * instructions and criteria, then the state.
 *
 * The criteria reach the model here rather than as JSON Schema descriptions,
 * which a provider may forward or drop from a structured-output request; the
 * frame is the same for every provider and is kept in the generation's
 * transcript. The schema carries the answer space alone.
 *
 * Built by concatenation with no template pass, so state text shaped like the
 * frame is never re-read as part of it. Its wording is not part of a decider's
 * version; `deciderFrame.test.ts` pins it so a change is a visible diff.
 */

const PREAMBLE =
  'Answer every question below about the state that follows. Choose each answer only from the ones its question offers.';

const answerLines = (question: DeciderQuestion): string[] => {
  switch (question.type) {
    case 'choice':
      return [
        'Answer with one of these options:',
        ...Object.entries(question.criteria).map(([option, description]) => {
          return `- ${option}: ${description}`;
        }),
      ];
    case 'score':
      return [
        'Answer with the number of the level that fits:',
        ...question.criteria.map((level, index) => {
          return `- ${index}: ${level}`;
        }),
      ];
    case 'boolean':
      return question.criteria
        ? [
            'Answer true or false:',
            `- false: ${question.criteria.false}`,
            `- true: ${question.criteria.true}`,
          ]
        : ['Answer true or false.'];
  }
};

/** A string state is shown as written; anything else as indented JSON. */
const renderState = (state: unknown): string => {
  return typeof state === 'string' ? state : JSON.stringify(state, null, 2);
};

export const renderDeciderFrame = (args: {
  questions: DeciderQuestions;
  state: unknown;
}): string => {
  const sections = Object.entries(args.questions).map(([id, question]) => {
    return [
      `### ${id} (${question.type})`,
      question.instructions,
      ...answerLines(question),
    ].join('\n');
  });

  return [
    PREAMBLE,
    '## Questions',
    ...sections,
    '## State',
    '<state>',
    renderState(args.state),
    '</state>',
  ].join('\n\n');
};
