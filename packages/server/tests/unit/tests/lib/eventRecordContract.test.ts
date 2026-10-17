import type { SoatEvent } from 'src/lib/eventBus';
import { asCustomEventName } from 'src/lib/soatEvents';

import { eventRecordFindings } from '../../eventRecordContract';

/**
 * The check `setupTestsAfterEnv.ts` runs over every event the suite emits.
 * Tested directly because its whole job is to fail, and an observer that never
 * fails cannot be told apart from one that works.
 */
const event = (overrides: Partial<SoatEvent>): SoatEvent => {
  return {
    id: 'evt_1',
    type: 'files.created',
    projectId: 1,
    projectPublicId: 'proj_1',
    resourceType: 'file',
    resourceId: 'file_1',
    data: { id: 'file_1', project_id: 'proj_1' },
    timestamp: new Date(0).toISOString(),
    ...overrides,
  };
};

describe('eventRecordFindings', () => {
  test('a record named by resource_id, all snake_case, holds the contract', () => {
    expect(eventRecordFindings(event({}))).toEqual([]);
  });

  test('a camelCase top-level key is a finding', () => {
    expect(
      eventRecordFindings(event({ data: { id: 'file_1', projectId: 'p' } }))
    ).toEqual(["files.created (file_1): camelCase key 'projectId'"]);
  });

  test('a camelCase key inside an opaque bag is not', () => {
    expect(
      eventRecordFindings(
        event({ data: { id: 'file_1', tags: { teamName: 'a' } } })
      )
    ).toEqual([]);
  });

  test('a record wrapped under a key is a finding', () => {
    expect(
      eventRecordFindings(event({ data: { file: { id: 'file_1' } } }))
    ).toEqual([
      'files.created (file_1): data.id is undefined, not the resource_id',
    ]);
  });

  test('a conversation message is named by its document_id', () => {
    const message = event({
      type: 'conversations.message.created',
      resourceType: 'conversation_message',
      resourceId: 'doc_1',
    });
    expect(
      eventRecordFindings({ ...message, data: { document_id: 'doc_1' } })
    ).toEqual([]);
    expect(eventRecordFindings({ ...message, data: { id: 'doc_1' } })).toEqual([
      'conversations.message.created (doc_1): data.document_id is undefined, not the resource_id',
    ]);
  });

  test('a user-authored event name is not held to it', () => {
    expect(
      eventRecordFindings(
        event({
          type: asCustomEventName({ name: 'order.shipped' }),
          data: { orderId: 'o_1' },
        })
      )
    ).toEqual([]);
  });
});
