import ts from 'typescript';

/**
 * Token kinds after which a `/` divides; after any other token it opens a
 * regular expression. Keywords such as `return` and `typeof` precede a regex.
 */
const OPERAND_END = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

const TRIVIA = new Set([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.ShebangTrivia,
  ts.SyntaxKind.ConflictMarkerTrivia,
]);

/** `type`, `as`, `of`…: most often a name, so a `/` after one divides. */
const isContextualKeyword = (kind) => {
  return (
    kind > ts.SyntaxKind.LastReservedWord && kind <= ts.SyntaxKind.LastKeyword
  );
};

const blank = (text) => {
  return text.replace(/[^\n]/g, ' ');
};

const COMMENT = new Set([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
]);

/** The token kind once a `/` or a template `}` is read in its context. */
const rescan = ({ scanner, kind, previous, braces }) => {
  const isSlash =
    kind === ts.SyntaxKind.SlashToken ||
    kind === ts.SyntaxKind.SlashEqualsToken;
  if (isSlash && !OPERAND_END.has(previous) && !isContextualKeyword(previous)) {
    return scanner.reScanSlashToken();
  }
  if (kind === ts.SyntaxKind.CloseBraceToken && braces.at(-1) === 'template') {
    return scanner.reScanTemplateToken(false);
  }
  return kind;
};

const OPENS = new Map([
  [ts.SyntaxKind.OpenBraceToken, 'block'],
  [ts.SyntaxKind.DollarBraceToken, 'block'],
  [ts.SyntaxKind.TemplateHead, 'template'],
]);

const CLOSES = new Set([
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.TemplateTail,
]);

/**
 * JavaScript or TypeScript `source` with every comment blanked to spaces,
 * newlines kept, so offsets and line numbers still match the file. Lexed, so
 * a `'/*'` or `'//'` inside a string, template or regex stays code.
 */
export const stripComments = (source) => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source
  );
  const braces = [];
  let previous;
  let out = '';
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    kind = rescan({ scanner, kind, previous, braces });
    if (OPENS.has(kind)) braces.push(OPENS.get(kind));
    if (CLOSES.has(kind)) braces.pop();
    const text = scanner.getTokenText();
    out += COMMENT.has(kind) ? blank(text) : text;
    if (!TRIVIA.has(kind)) previous = kind;
  }
  return out;
};
