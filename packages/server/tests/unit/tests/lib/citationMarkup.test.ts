import {
  citationMarkupStripStream,
  createCitationMarkupStripper,
  parseCitationMarkup,
} from 'src/lib/citationMarkup';

const streamed = (args: { chunks: string[] }): string => {
  const stripper = createCitationMarkupStripper();
  const out = args.chunks.map((chunk) => {
    return stripper.push(chunk);
  });
  return out.join('') + stripper.flush();
};

describe('parseCitationMarkup', () => {
  test('strips the tags and spans the claim they wrap', () => {
    const parsed = parseCitationMarkup({
      text: 'Intro. <cite ref="c1" quote="max 40 mg/day">The dose is 40 mg.</cite> End.',
    });
    expect(parsed.content).toBe('Intro. The dose is 40 mg. End.');
    expect(parsed.marks).toEqual([
      {
        ref: 'c1',
        quote: 'max 40 mg/day',
        answerSpan: { start: 7, end: 25 },
      },
    ]);
    expect(parsed.malformed).toEqual([]);
  });

  test('reads attributes in any order and decodes entities', () => {
    const parsed = parseCitationMarkup({
      text: '<cite quote="a &quot;b&quot; &amp; c &gt; d" ref="c2">x</cite>',
    });
    expect(parsed.marks).toEqual([
      { ref: 'c2', quote: 'a "b" & c > d', answerSpan: { start: 0, end: 1 } },
    ]);
  });

  test('a raw > inside a quoted attribute does not end the tag', () => {
    const parsed = parseCitationMarkup({
      text: '<cite ref="c1" quote="ClCr > 30">ok</cite>',
    });
    expect(parsed.content).toBe('ok');
    expect(parsed.marks[0].quote).toBe('ClCr > 30');
  });

  test('spans count code points, not UTF-16 units', () => {
    const parsed = parseCitationMarkup({
      text: '😀 <cite ref="c1" quote="q">ação</cite>',
    });
    expect(parsed.marks[0].answerSpan).toEqual({ start: 2, end: 6 });
  });

  test('keeps several marks in order', () => {
    const parsed = parseCitationMarkup({
      text: '<cite ref="c1" quote="a">A</cite> and <cite ref="c3" quote="b">B</cite>',
    });
    expect(parsed.content).toBe('A and B');
    expect(
      parsed.marks.map((mark) => {
        return mark.ref;
      })
    ).toEqual(['c1', 'c3']);
  });

  test('a tag missing ref or quote is malformed and its text is kept', () => {
    const parsed = parseCitationMarkup({
      text: '<cite ref="c1">claim</cite>',
    });
    expect(parsed.content).toBe('claim');
    expect(parsed.marks).toEqual([]);
    expect(parsed.malformed).toEqual([{ ref: 'c1', quote: null }]);
  });

  test('a blank quote is malformed', () => {
    const parsed = parseCitationMarkup({
      text: '<cite ref="c1" quote="  ">claim</cite>',
    });
    expect(parsed.marks).toEqual([]);
    expect(parsed.malformed).toEqual([{ ref: 'c1', quote: '  ' }]);
  });

  test('an unclosed tag is malformed and its text is kept', () => {
    const parsed = parseCitationMarkup({
      text: 'A <cite ref="c1" quote="q">claim',
    });
    expect(parsed.content).toBe('A claim');
    expect(parsed.malformed).toEqual([{ ref: 'c1', quote: 'q' }]);
  });

  test('a stray closing tag is dropped and counted as malformed', () => {
    const parsed = parseCitationMarkup({ text: 'A</cite> B' });
    expect(parsed.content).toBe('A B');
    expect(parsed.malformed).toEqual([{ ref: null, quote: null }]);
  });

  test('a nested opening tag closes the outer one as malformed', () => {
    const parsed = parseCitationMarkup({
      text: '<cite ref="c1" quote="a">x <cite ref="c2" quote="b">y</cite>',
    });
    expect(parsed.content).toBe('x y');
    expect(parsed.malformed).toEqual([{ ref: 'c1', quote: 'a' }]);
    expect(parsed.marks).toEqual([
      { ref: 'c2', quote: 'b', answerSpan: { start: 2, end: 3 } },
    ]);
  });

  test('text that only looks like a tag is left alone', () => {
    const text = 'a <citation> b <city c < d </ci';
    const parsed = parseCitationMarkup({ text });
    expect(parsed.content).toBe(text);
    expect(parsed.marks).toEqual([]);
    expect(parsed.malformed).toEqual([]);
  });

  test('an overlong opening tag is prose, not a tag', () => {
    const text = `<cite ref="c1" ${'x'.repeat(5000)}>claim</cite>`;
    const parsed = parseCitationMarkup({ text });
    expect(parsed.content).toBe(`<cite ref="c1" ${'x'.repeat(5000)}>claim`);
    expect(parsed.malformed).toEqual([{ ref: null, quote: null }]);
  });

  test('an opening tag that never ends is kept as text', () => {
    const text = 'a <cite ref="c1" quote="never closed';
    expect(parseCitationMarkup({ text }).content).toBe(text);
  });
});

describe('createCitationMarkupStripper', () => {
  const samples = [
    'Intro. <cite ref="c1" quote="max 40 mg/day">The dose is 40 mg.</cite> End.',
    '<cite quote="ClCr > 30" ref="c2">x</cite></cite>',
    'a <citation> b <city c < d </ci',
    'a <cite ref="c1" quote="never closed',
    'A <cite ref="c1" quote="q">claim',
  ];

  test.each(samples)('streams exactly the parsed content: %s', (text) => {
    const expected = parseCitationMarkup({ text }).content;
    expect(streamed({ chunks: [text] })).toBe(expected);
    expect(streamed({ chunks: Array.from(text) })).toBe(expected);
    expect(
      streamed({
        chunks: [text.slice(0, 5), text.slice(5, 17), text.slice(17)],
      })
    ).toBe(expected);
  });

  test('never emits a partial tag', () => {
    const stripper = createCitationMarkupStripper();
    expect(stripper.push('A <ci')).toBe('A ');
    expect(stripper.push('te ref="c1" quote="q"')).toBe('');
    expect(stripper.push('>claim</ci')).toBe('claim');
    expect(stripper.push('te> done')).toBe(' done');
    expect(stripper.flush()).toBe('');
  });
});

describe('citationMarkupStripStream', () => {
  test('pipes a chunked stream into the parsed content', async () => {
    const text = 'A <cite ref="c1" quote="q">claim</cite> and <citation> b <ci';
    const source = new ReadableStream<string>({
      start: (controller) => {
        for (const chunk of [
          text.slice(0, 7),
          text.slice(7, 30),
          text.slice(30),
        ]) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const reader = source.pipeThrough(citationMarkupStripStream()).getReader();
    let out = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      out += chunk.value;
    }
    expect(out).toBe(parseCitationMarkup({ text }).content);
  });
});
