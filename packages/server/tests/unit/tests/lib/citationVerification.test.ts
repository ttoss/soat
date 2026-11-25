import {
  type CitationSource,
  verifyCitations,
} from 'src/lib/citationVerification';

const page12: CitationSource = {
  origin: 'retrieval',
  documentId: 'doc_A',
  documentVersion: 3,
  chunkId: 'dchunk_K9',
  fileId: null,
  page: 12,
  text: 'Posologia.\nA dose  máxima de 40 mg/dia\nnão deve ser excedida.',
};

const verify = (args: {
  ref?: string;
  quote: string;
  sources?: Record<string, CitationSource | null>;
}) => {
  return verifyCitations({
    marks: [
      {
        ref: args.ref ?? 'c1',
        quote: args.quote,
        answerSpan: { start: 0, end: 10 },
      },
    ],
    malformed: [],
    sources: args.sources ?? { c1: page12 },
  });
};

describe('verifyCitations', () => {
  test('a verbatim quote becomes a citation with the source text and spans', () => {
    expect(verify({ quote: 'não deve ser excedida' })).toEqual({
      citations: [
        {
          origin: 'retrieval',
          document_id: 'doc_A',
          document_version: 3,
          chunk_id: 'dchunk_K9',
          file_id: null,
          page: 12,
          page_end: 12,
          quoted_text: 'não deve ser excedida',
          source_span: { start: 39, end: 60 },
          answer_span: { start: 0, end: 10 },
          verification: 'runtime',
        },
      ],
      rejected: [],
    });
  });

  test('whitespace runs match across line breaks; quoted_text is the source as written', () => {
    const { citations } = verify({
      quote: 'dose máxima de 40 mg/dia não deve',
    });
    expect(citations[0].quoted_text).toBe(
      'dose  máxima de 40 mg/dia\nnão deve'
    );
    expect(citations[0].source_span).toEqual({ start: 13, end: 47 });
  });

  test('a decomposed quote matches composed source text', () => {
    const { citations } = verify({ quote: 'máxima' });
    expect(citations[0].quoted_text).toBe('máxima');
  });

  test('a quote the source does not contain is rejected', () => {
    expect(verify({ quote: 'dose máxima de 80 mg/dia' })).toEqual({
      citations: [],
      rejected: [
        {
          ref: 'c1',
          quoted_text: 'dose máxima de 80 mg/dia',
          reason: 'QUOTE_NOT_FOUND',
        },
      ],
    });
  });

  test('a blank quote matches nothing', () => {
    expect(verify({ quote: ' \n ' }).rejected[0].reason).toBe(
      'QUOTE_NOT_FOUND'
    );
  });

  test('matching is case-sensitive', () => {
    expect(verify({ quote: 'Não deve' }).rejected[0].reason).toBe(
      'QUOTE_NOT_FOUND'
    );
  });

  test('a ref the turn never injected is rejected', () => {
    expect(verify({ ref: 'c7', quote: 'dose' }).rejected).toEqual([
      { ref: 'c7', quoted_text: 'dose', reason: 'UNKNOWN_REF' },
    ]);
  });

  test('a source that no longer resolves is rejected', () => {
    expect(
      verify({ quote: 'dose', sources: { c1: null } }).rejected[0].reason
    ).toBe('SOURCE_UNAVAILABLE');
  });

  test('a page-less source cites with null pages', () => {
    const { citations } = verify({
      quote: 'dose',
      sources: { c1: { ...page12, page: null } },
    });
    expect(citations[0].page).toBeNull();
    expect(citations[0].page_end).toBeNull();
  });

  test('malformed markup is reported as rejected, after the marks', () => {
    const result = verifyCitations({
      marks: [],
      malformed: [
        { ref: 'c1', quote: null },
        { ref: null, quote: null },
      ],
      sources: { c1: page12 },
    });
    expect(result.rejected).toEqual([
      { ref: 'c1', quoted_text: null, reason: 'MALFORMED_CITE' },
      { ref: null, quoted_text: null, reason: 'MALFORMED_CITE' },
    ]);
  });

  test('spans count code points of the source', () => {
    const { citations } = verify({
      quote: 'alvo',
      sources: { c1: { ...page12, text: '😀😀 alvo' } },
    });
    expect(citations[0].source_span).toEqual({ start: 3, end: 7 });
  });

  test('an attached file page cites by file and page, with no document', () => {
    const { citations } = verify({
      quote: 'hemograma completo',
      sources: {
        a1: {
          origin: 'attached_file',
          documentId: null,
          documentVersion: null,
          chunkId: null,
          fileId: 'file_L4',
          page: 2,
          text: 'Conduta: solicito hemograma completo e creatinina.',
        },
      },
      ref: 'a1',
    });
    expect(citations[0]).toEqual({
      origin: 'attached_file',
      document_id: null,
      document_version: null,
      chunk_id: null,
      file_id: 'file_L4',
      page: 2,
      page_end: 2,
      quoted_text: 'hemograma completo',
      source_span: { start: 18, end: 36 },
      answer_span: { start: 0, end: 10 },
      verification: 'runtime',
    });
  });
});
