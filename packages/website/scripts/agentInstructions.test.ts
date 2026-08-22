import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAgentInstructionsMarkdown,
  buildLlmsRootContent,
  CALLING_RULES,
  NOT_FOR,
  ONBOARDING_STEPS,
  USE_CASES,
} from '../src/data/agentInstructions';

test('every use case names a job and the call that does it', () => {
  assert.ok(USE_CASES.length >= 5, 'a handful of jobs is not guidance');

  for (const useCase of USE_CASES) {
    assert.ok(useCase.job.length > 0, 'job');
    // "Be specific about the jobs you are right for — generic marketing copy
    // does not read as guidance": a use case with no operation in it is copy.
    assert.match(
      useCase.how,
      /`/,
      `${useCase.job}: must name a concrete call, not just a capability`
    );
  }
});

test('the guidance says when not to use SOAT, not only when to', () => {
  assert.ok(NOT_FOR.length >= 2);

  for (const entry of NOT_FOR) {
    assert.ok(entry.length > 40, `too terse to act on: "${entry}"`);
  }
});

test('the calling rules cover what a first call needs', () => {
  const topics = CALLING_RULES.map((rule) => {
    return rule.topic;
  });

  for (const required of [
    'Surfaces',
    'Contract',
    'Base URL',
    'Authentication',
    'Errors',
  ]) {
    assert.ok(topics.includes(required), `missing calling rule: ${required}`);
  }
});

test('the base-URL rule says the docs domain serves no API', () => {
  // The single most expensive mistake an agent can make here is to send calls
  // at soat.ttoss.dev, which is a static site. Saying so is the guidance.
  const rule = CALLING_RULES.find((entry) => {
    return entry.topic === 'Base URL';
  });

  assert.ok(rule);
  assert.match(rule.rule, /soat\.ttoss\.dev/);
  assert.match(rule.rule, /documentation only|no API/);
});

test('onboarding is self-serve end to end', () => {
  const text = ONBOARDING_STEPS.map((step) => {
    return `${step.step} ${step.detail}`;
  })
    .join(' ')
    .toLowerCase();

  // An agent cannot fill in a form or wait for a human, so any of these words
  // in the onboarding path is a dead end for it.
  for (const blocker of ['contact sales', 'contact us', 'request access']) {
    assert.ok(!text.includes(blocker), `onboarding mentions "${blocker}"`);
  }
  assert.match(text, /api-keys|api key/);
  assert.match(text, /docker compose/);
});

test('the instruction file carries every section an agent needs', () => {
  const markdown = buildAgentInstructionsMarkdown();

  for (const heading of [
    '# SOAT — instructions for agents',
    '## When to use SOAT',
    '## When not to use SOAT',
    '## How an agent should call SOAT',
    '## Getting access',
    '## Machine-readable surfaces',
  ]) {
    assert.ok(markdown.includes(heading), `missing section: ${heading}`);
  }

  // Long enough to be read as a document, short enough to be read at all.
  assert.ok(markdown.length > 2000, 'too thin to be instructions');
  assert.ok(markdown.length < 20_000, 'too long to be read as instructions');
});

test('every use case and onboarding step reaches the instruction file', () => {
  const markdown = buildAgentInstructionsMarkdown();

  for (const useCase of USE_CASES) {
    assert.ok(markdown.includes(useCase.job), `dropped: ${useCase.job}`);
  }
  for (const step of ONBOARDING_STEPS) {
    assert.ok(markdown.includes(step.step), `dropped: ${step.step}`);
  }
});

test('the llms.txt preamble carries the same guidance and links the file', () => {
  const preamble = buildLlmsRootContent();

  assert.ok(preamble.includes('## When to use SOAT'));
  assert.ok(preamble.includes('## Getting access'));
  assert.ok(preamble.includes('https://soat.ttoss.dev/agents.md'));
});
