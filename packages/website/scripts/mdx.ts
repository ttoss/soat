/**
 * Escaping for generated Markdown pages.
 *
 * Docusaurus parses `.md` as MDX, so a bare `{` opens a JSX expression and a
 * bare `<` opens a tag. Generated pages carry text nobody reviews as MDX — API
 * descriptions, error-registry descriptions, formation schema docs — and each
 * unescaped character fails the build with an acorn parse error pointing at a
 * file no one edited.
 *
 * One implementation, shared by every generator, because there were two: this
 * one and a `{`/`}`-only version inside `generateFormationsResourceDocs.ts`
 * that left `<` alone and escaped inside code spans.
 */

/**
 * `text` with every MDX-hostile character escaped outside inline-code spans.
 *
 * Code spans are left verbatim: MDX does not parse inside them, and an escape
 * there would render as a literal backslash — which the one registry
 * description whose shape example is a code span full of braces
 * (`CONVERTER_OUTPUT_INVALID`) would have shown.
 *
 * Spans are matched by CommonMark's rule: a run of N backticks closed by a
 * later run of exactly N. Getting that wrong is what let the second round of
 * this bug through — a naive pairwise split reads the first two backticks of a
 * stray ``` as an empty span, then treats the rest of the line as code and
 * escapes none of it.
 */
export const escapeMdx = (text: string): string => {
  const tokens = text.split(/(`+)/);

  let out = '';

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token.startsWith('`')) {
      out += token.replace(/[<>{}]/g, (char) => {
        return `\\${char}`;
      });
      continue;
    }

    const closingIndex = tokens.findIndex((candidate, at) => {
      return at > index && candidate === token;
    });

    if (closingIndex < 0) {
      // Unclosed run: literal backticks, so what follows is ordinary text.
      out += token;
      continue;
    }

    out += tokens.slice(index, closingIndex + 1).join('');
    index = closingIndex;
  }

  return out;
};
