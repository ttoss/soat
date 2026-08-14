import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { objectEntriesAt } from '../../scripts/docs-lint.mjs';

/**
 * `objectEntriesAt` is the parser behind docs-lint's SDK/curl body-field check —
 * it reads the top-level keys of one object literal in a doc example.
 *
 * It is pinned here because both of its failure modes are silent in the *noisy*
 * direction: an over-broad read reported 180 violations that did not exist, and a
 * string-blind read reported a field named `https` for every `url: 'https://…'`.
 * A check that cries wolf gets deleted, which would put the drift class it
 * guards (a documented body field no endpoint accepts) back where #992 found it.
 *
 * The keys are what the check compares against the OpenAPI-derived allowlist, so
 * the contract is: exactly the object's own keys, never a value, never a
 * neighbour's.
 */
const keysAt = (text, from = 0) => {
  return objectEntriesAt(text, from)?.map((entry) => {
    return entry.key;
  });
};

describe('docs-lint objectEntriesAt', () => {
  test('reads the top-level keys of an object literal', () => {
    assert.deepEqual(keysAt(`{ name: 'Bot', external_id: '+1555' }`), [
      'name',
      'external_id',
    ]);
  });

  test('reads quoted keys, the way a curl JSON payload spells them', () => {
    assert.deepEqual(keysAt(`{"message": "hi", "role": "user"}`), [
      'message',
      'role',
    ]);
  });

  test('does not read structure out of a string value', () => {
    // The `https:` inside the URL is a value, not a field — reading it reported
    // `createWebhook body.https` on every webhook example.
    assert.deepEqual(
      keysAt(`{ url: 'https://example.com/hook', events: ['*'] }`),
      ['url', 'events']
    );
  });

  test('ignores a colon inside prose', () => {
    assert.deepEqual(keysAt(`{ instructions: 'Answer this: briefly' }`), [
      'instructions',
    ]);
  });

  test('ignores keys nested inside the object', () => {
    // Only top-level fields are checked: the allowlist is flattened to the
    // body's own fields, so a nested key must not be judged against it.
    assert.deepEqual(
      keysAt(`{ execute: { type: 'http', url: 'https://x' }, name: 'tool' }`),
      ['execute', 'name']
    );
  });

  test('ignores keys nested inside an array of objects', () => {
    assert.deepEqual(
      keysAt(`{ messages: [{ role: 'user', content: 'hi' }], model: 'x' }`),
      ['messages', 'model']
    );
  });

  test('stops at the end of its own object', () => {
    // The bug that produced 180 phantom violations: reading past the closing
    // brace attributed the *next* example's fields to this call.
    assert.deepEqual(keysAt(`{ a: 1 } , body: { b: 2 }`), ['a']);
  });

  test('returns null when the position holds no object literal', () => {
    // `body: payload` — a variable, so there is nothing to check.
    assert.equal(keysAt(`payload, query: { wait: true }`), undefined);
  });

  test('returns null for an unterminated object', () => {
    assert.equal(keysAt(`{ name: 'Bot',`), undefined);
  });

  test('reports where each value starts, so a nested object can be entered', () => {
    const text = `{ body: { message: 'hi' } }`;
    const body = objectEntriesAt(text, 0).find((entry) => {
      return entry.key === 'body';
    });
    assert.deepEqual(keysAt(text, body.valueStart), ['message']);
  });
});
