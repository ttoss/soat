import {
  signIngestionCallbackToken,
  verifyIngestionCallbackToken,
} from 'src/lib/ingestionCallbackToken';

describe('verifyIngestionCallbackToken', () => {
  test('accepts a token verified against the document it was signed for', () => {
    const token = signIngestionCallbackToken({
      documentId: 'doc_1',
      attemptId: 'iat_1',
    });
    expect(
      verifyIngestionCallbackToken({ token, documentId: 'doc_1' })
    ).toEqual({ attemptId: 'iat_1' });
  });

  test('rejects a token verified against a different document', () => {
    const token = signIngestionCallbackToken({
      documentId: 'doc_1',
      attemptId: 'iat_1',
    });
    expect(
      verifyIngestionCallbackToken({ token, documentId: 'doc_2' })
    ).toBeNull();
  });

  test('rejects a malformed token', () => {
    expect(
      verifyIngestionCallbackToken({ token: 'not-a-jwt', documentId: 'doc_1' })
    ).toBeNull();
  });
});
