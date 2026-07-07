import { resolveGenerationInputMessages } from 'src/lib/generationInputMessages';

// resolveGenerationInputMessages is a thin wrapper over resolveMessageContent:
// it passes array content (raw AI SDK tool messages) through untouched and
// delegates everything else. Its own branches (array passthrough + delegation)
// are covered here without mocking. The document/tool_output resolution logic
// it delegates to lives in messageContent.ts and is covered by
// messageContent.test.ts; the one delegated branch not exercised there — a
// missing document — is driven here for real (a nonexistent id makes the real
// getDocument return null), so no src/** module is mocked.
describe('resolveGenerationInputMessages', () => {
  test('keeps string message content unchanged', async () => {
    const result = await resolveGenerationInputMessages({
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('passes array content through unchanged (raw AI SDK tool messages)', async () => {
    const toolCallContent = [
      {
        type: 'tool-call',
        toolCallId: 'tc_1',
        toolName: 'create-account',
        args: {},
      },
    ];
    const toolResultContent = [
      {
        type: 'tool-result',
        toolCallId: 'tc_1',
        toolName: 'create-account',
        result: 'ok',
      },
    ];

    const result = await resolveGenerationInputMessages({
      messages: [
        { role: 'assistant', content: toolCallContent },
        { role: 'tool', content: toolResultContent },
      ],
    });

    expect(result).toEqual([
      { role: 'assistant', content: toolCallContent },
      { role: 'tool', content: toolResultContent },
    ]);
  });

  test('throws when a document message references a nonexistent document', async () => {
    // No mocking: the real getDocument returns null for a missing id, which
    // makes resolveDocumentContent throw before any collaborator is reached.
    await expect(
      resolveGenerationInputMessages({
        messages: [
          {
            role: 'user',
            content: { type: 'document', documentId: 'doc_missing' },
          },
        ],
      })
    ).rejects.toThrow("Document 'doc_missing' not found");
  });
});
