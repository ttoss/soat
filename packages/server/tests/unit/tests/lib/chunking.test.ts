import {
  chunkPages,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  joinChunks,
} from 'src/lib/chunking';

describe('chunking', () => {
  describe('constants', () => {
    test('DEFAULT_CHUNK_SIZE is 1000', () => {
      expect(DEFAULT_CHUNK_SIZE).toBe(1000);
    });

    test('DEFAULT_CHUNK_OVERLAP is 200', () => {
      expect(DEFAULT_CHUNK_OVERLAP).toBe(200);
    });
  });

  describe('chunkPages — whole strategy', () => {
    test('joins all pages with newlines into a single chunk', () => {
      const chunks = chunkPages({
        pages: [
          { text: 'page one' },
          { text: 'page two' },
          { text: 'page three' },
        ],
        strategy: 'whole',
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('page one\npage two\npage three');
      expect(chunks[0].chunkIndex).toBe(0);
    });

    test('single page produces one chunk', () => {
      const chunks = chunkPages({
        pages: [{ text: 'only page' }],
        strategy: 'whole',
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('only page');
    });

    test('empty pages array produces an empty-content chunk', () => {
      const chunks = chunkPages({ pages: [], strategy: 'whole' });
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('');
    });
  });

  describe('chunkPages — page strategy', () => {
    test('each page becomes its own chunk with the correct index', () => {
      const chunks = chunkPages({
        pages: [
          { text: 'first', pageNumber: 1 },
          { text: 'second', pageNumber: 2 },
        ],
        strategy: 'page',
      });
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({
        content: 'first',
        chunkIndex: 0,
        pageNumber: 1,
      });
      expect(chunks[1]).toEqual({
        content: 'second',
        chunkIndex: 1,
        pageNumber: 2,
      });
    });

    test('pages without pageNumber produce chunks without pageNumber', () => {
      const chunks = chunkPages({
        pages: [{ text: 'no number' }],
        strategy: 'page',
      });
      expect(chunks[0].pageNumber).toBeUndefined();
    });
  });

  describe('chunkPages — size strategy', () => {
    test('splits text into overlapping windows', () => {
      const text = 'a'.repeat(100);
      const chunks = chunkPages({
        pages: [{ text }],
        strategy: 'size',
        chunkSize: 20,
        chunkOverlap: 5,
      });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].content).toHaveLength(20);
      expect(chunks[0].chunkIndex).toBe(0);
    });

    test('short text fits in a single chunk', () => {
      const chunks = chunkPages({
        pages: [{ text: 'short' }],
        strategy: 'size',
        chunkSize: 100,
        chunkOverlap: 10,
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('short');
    });

    test('uses DEFAULT_CHUNK_SIZE and DEFAULT_CHUNK_OVERLAP when not specified', () => {
      const text = 'x'.repeat(1500);
      const chunks = chunkPages({
        pages: [{ text }],
        strategy: 'size',
      });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].content).toHaveLength(DEFAULT_CHUNK_SIZE);
    });

    test('combines multiple pages before splitting', () => {
      const chunks = chunkPages({
        pages: [{ text: 'abc' }, { text: 'def' }],
        strategy: 'size',
        chunkSize: 5,
        chunkOverlap: 0,
      });
      // combined = "abc\ndef" (7 chars), chunkSize=5 → ["abc\nd", "ef"]
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].content).toContain('abc');
    });
  });

  describe('joinChunks', () => {
    const roundTrip = (args: {
      pages: string[];
      chunkSize: number;
      chunkOverlap: number;
    }) => {
      const chunks = chunkPages({
        pages: args.pages.map((text) => {
          return { text };
        }),
        strategy: 'size',
        chunkSize: args.chunkSize,
        chunkOverlap: args.chunkOverlap,
      });
      return joinChunks({
        chunks: chunks.map((c) => {
          return c.content;
        }),
        strategy: 'size',
        chunkSize: args.chunkSize,
        chunkOverlap: args.chunkOverlap,
      });
    };

    test('size strategy yields the text it was split from, overlap once', () => {
      const text = Array.from({ length: 500 }, (_, i) => {
        return `${String(i).padStart(4, '0')}|`;
      }).join('');

      expect(
        roundTrip({ pages: [text], chunkSize: 1000, chunkOverlap: 200 })
      ).toBe(text);
    });

    test.each([
      { length: 0, chunkSize: 10, chunkOverlap: 3 },
      { length: 7, chunkSize: 10, chunkOverlap: 3 },
      { length: 20, chunkSize: 10, chunkOverlap: 0 },
      { length: 23, chunkSize: 10, chunkOverlap: 3 },
      { length: 23, chunkSize: 10, chunkOverlap: 50 },
      { length: 31, chunkSize: 1, chunkOverlap: 0 },
    ])('size strategy round-trips %o', (args) => {
      const text = Array.from({ length: args.length }, (_, i) => {
        return String.fromCharCode(97 + (i % 26));
      }).join('');

      expect(
        roundTrip({
          pages: [text],
          chunkSize: args.chunkSize,
          chunkOverlap: args.chunkOverlap,
        })
      ).toBe(text);
    });

    test('size strategy over several pages yields them joined by newlines', () => {
      expect(
        roundTrip({ pages: ['abc', 'def'], chunkSize: 5, chunkOverlap: 2 })
      ).toBe('abc\ndef');
    });

    test('size strategy falls back to the default size and overlap', () => {
      const text = 'x'.repeat(1500) + 'y'.repeat(1500);
      const chunks = chunkPages({ pages: [{ text }], strategy: 'size' });

      expect(
        joinChunks({
          chunks: chunks.map((c) => {
            return c.content;
          }),
          strategy: 'size',
        })
      ).toBe(text);
    });

    test('page and whole strategies join chunks by newlines', () => {
      expect(joinChunks({ chunks: ['a', 'b'], strategy: 'page' })).toBe('a\nb');
      expect(joinChunks({ chunks: ['a\nb'], strategy: 'whole' })).toBe('a\nb');
    });
  });
});
