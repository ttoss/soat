import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

const sourceFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  });

const filesMatching = (pattern) => {
  return sourceFiles
    .filter((entry) => {
      return pattern.test(code(path.join(srcDir, entry)));
    })
    .sort();
};

/**
 * Where a message lands in a conversation is answered once per question:
 * `insertMessage` takes a position under the conversation's lock, so writes
 * never race on one, and `storeResumedConversationTurn` places a turn resumed
 * through tool outputs, whichever route resumed it.
 */
describe('conversation chokepoints', () => {
  test('a message row is written only by insertMessage', () => {
    assert.deepEqual(
      filesMatching(/ConversationMessage\.(create|bulkCreate|upsert)\(/),
      [
        'lib/conversationMessageWrites.ts',
        // A fork copies positions verbatim into a conversation its own
        // transaction creates, which no other writer can see until it commits.
        'lib/sessionFork.ts',
      ]
    );
  });

  test('a conversation or its messages are deleted only through conversationTurnDocuments', () => {
    assert.deepEqual(
      filesMatching(
        /\b(Conversation|ConversationMessage|conversation|message)\.destroy\(/
      ),
      [
        'lib/conversationTurnDocuments.ts',
        // A project delete takes every document in the project with it.
        'lib/projectDependents.ts',
      ]
    );
  });

  test('a generated turn is stored only inside conversationGeneration', () => {
    assert.deepEqual(filesMatching(/\bstoreGeneratedTurn\b/), [
      'lib/conversationGeneration.ts',
    ]);
  });
});

/**
 * Every transaction-scoped advisory lock keys on a namespace from one registry,
 * so two kinds of row never contend on one id.
 */
describe('advisory locks', () => {
  test('are taken only through lockForTransaction', () => {
    assert.deepEqual(filesMatching(/pg_advisory_xact_lock/), [
      'lib/advisoryLocks.ts',
      // Keys on two row ids, (agent, actor), rather than a namespace and one.
      'lib/sessions.ts',
    ]);
  });
});
