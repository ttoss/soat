import type { DeciderQuestion, DeciderQuestions } from './deciderQuestions';

/**
 * The message an agent-backed decision sends: the questions with their
 * instructions, choices and levels, then the input.
 *
 * The descriptions reach the model here rather than as JSON Schema
 * descriptions, which a provider may forward or drop from a structured-output
 * request; the frame is the same for every provider and is kept in the
 * generation's transcript. The schema carries the answer space alone.
 *
 * Built by concatenation with no template pass, so input text shaped like the
 * frame is never re-read as part of it. Its wording is not part of a decider's
 * version; `rest/decisions.test.ts` pins it so a change is a visible diff.
 */

const PREAMBLE =
  'Answer every question below about the input that follows. Choose each answer only from the ones its question offers.';

const answerLines = (question: DeciderQuestion): string[] => {
  switch (question.type) {
    case 'predicate':
      return ['Answer true if the condition holds, false otherwise.'];
    case 'choice':
      return [
        'Answer with one of these values:',
        ...question.choices.map((choice) => {
          return `- ${choice.value}: ${choice.description}`;
        }),
      ];
    case 'score':
      return [
        'Answer with the number of the level that fits:',
        ...question.levels.map((level, index) => {
          return `- ${index}: ${level.label}. ${level.description}`;
        }),
      ];
  }
};

export const renderDeciderFrame = (args: {
  questions: DeciderQuestions;
  /** The input's text, as `parseDecisionInput` renders it. */
  inputText: string;
}): string => {
  const sections = args.questions.map((question) => {
    return [
      `### ${question.name} (${question.type})`,
      question.instructions,
      ...answerLines(question),
    ].join('\n');
  });

  return [
    PREAMBLE,
    '## Questions',
    ...sections,
    '## Input',
    '<input>',
    args.inputText,
    '</input>',
  ].join('\n\n');
};
