import createDebug from 'debug';

import { DomainError } from '../errors';

const log = createDebug('soat:validation');

/** One reason a definition was refused, as `meta.problems` lists it. */
export type ValidationProblem = {
  code: Uppercase<string>;
  /** Where in the request body, in wire (snake_case) names. */
  path: string;
  message: string;
};

type ValidationFailureCode =
  | 'ORCHESTRATION_VALIDATION_FAILED'
  | 'PLAYBOOK_VALIDATION_FAILED'
  | 'WORKFLOW_VALIDATION_FAILED';

/**
 * Refuses a definition with every problem found, under the one `meta` shape a
 * validation refusal has. `warnings` is required so a module states whether it
 * has non-blocking problems rather than silently dropping them.
 */
export const throwValidationProblems = (args: {
  code: ValidationFailureCode;
  subject: string;
  problems: ValidationProblem[];
  warnings: ValidationProblem[] | null;
}): never => {
  log(
    'throwValidationProblems: code=%s problems=%d',
    args.code,
    args.problems.length
  );
  const summary = args.problems
    .map((problem) => {
      return `${problem.path}: ${problem.message}`;
    })
    .join('; ');
  throw new DomainError(
    args.code,
    `${args.subject} validation failed: ${summary}`,
    {
      problems: args.problems,
      ...(args.warnings !== null && { warnings: args.warnings }),
    }
  );
};
