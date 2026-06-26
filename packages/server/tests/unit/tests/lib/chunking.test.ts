import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  chunkPages,
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
      expect(chunks[0]).toEqual({ content: 'first', chunkIndex: 0, pageNumber: 1 });
      expect(chunks[1]).toEqual({ content: 'second', chunkIndex: 1, pageNumber: 2 });
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
});
