import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/**
 * An error `message` states what was refused; what to do about it is the
 * code's `hint`, which a deployment fronting the API replaces or omits
 * (`errors/hintOverrides.ts`). Advice in a message reaches that deployment's
 * callers naming routes and remedies it does not offer.
 */
const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE) \//;

const ADVICE_VERBS = [
  'add',
  'ask',
  'call',
  'change',
  'choose',
  'configure',
  'create',
  'declare',
  'delete',
  'edit',
  'grant',
  'have',
  'mint',
  'name',
  'omit',
  'pass',
  'provide',
  'reduce',
  'register',
  'remove',
  'repoint',
  'resume',
  'retry',
  'rotate',
  'select',
  'send',
  'set',
  'split',
  'supply',
  'try',
  'update',
  'upload',
  'use',
];

const VERBS = ADVICE_VERBS.join('|');

/** A field named as a subject (`name must be…`) is not a command. */
const NOT_SUBJECT = String.raw`(?!\s+(?:is|are|must|cannot|has|was|were|should)\b)`;

/**
 * A sentence opens on a capitalised verb; a clause after `;`, `—` or `(` may
 * open on a lowercase one.
 */
const IMPERATIVES = [
  new RegExp(
    String.raw`(?:^|[.!?]\s+)((?:${VERBS.replace(
      /(^|\|)(\w)/g,
      (_m, bar, first) => {
        return `${bar}${first.toUpperCase()}`;
      }
    )}))\b${NOT_SUBJECT}`
  ),
  new RegExp(String.raw`(?:[;—(]\s*)(${VERBS})\b${NOT_SUBJECT}`, 'i'),
];

/** Why `message` carries advice, or `null` when it states a fact only. */
export const adviceIn = (message) => {
  if (ROUTE.test(message)) return 'names a route';
  for (const imperative of IMPERATIVES) {
    const verb = message.match(imperative);
    if (verb) return `tells the caller to act ("${verb[1]}")`;
  }
  return null;
};

const tsFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

/** Every initializer a name is declared with in the file. */
const declarations = (sourceFile) => {
  const byName = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const list = byName.get(node.name.text) ?? [];
      list.push(node.initializer);
      byName.set(node.name.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return byName;
};

const HOLE = '${…}';

const isConcatenation = (node) => {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
};

const isLiteral = (node) => {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
};

/** How each expression kind reads, given how to read a child. */
const READERS = [
  [
    isLiteral,
    (node) => {
      return node.text;
    },
  ],
  [
    ts.isTemplateExpression,
    (node, next) => {
      return (
        node.head.text +
        node.templateSpans
          .map((span) => {
            return next(span.expression) + span.literal.text;
          })
          .join('')
      );
    },
  ],
  [
    isConcatenation,
    (node, next) => {
      return next(node.left) + next(node.right);
    },
  ],
  [
    ts.isParenthesizedExpression,
    (node, next) => {
      return next(node.expression);
    },
  ],
  [
    ts.isConditionalExpression,
    (node, next) => {
      return `${next(node.whenTrue)} | ${next(node.whenFalse)}`;
    },
  ],
  [
    ts.isIdentifier,
    (node, next, names) => {
      const initializers = names.get(node.text);
      return initializers
        ? initializers
            .map((initializer) => {
              return next(initializer);
            })
            .join(' | ')
        : HOLE;
    },
  ],
];

/** The literal text of a message expression, holes for what is computed. */
const textOf = (node, names, depth = 0) => {
  const reader = READERS.find(([matches]) => {
    return matches(node);
  });
  if (!reader || depth > 8) return HOLE;
  return reader[1](
    node,
    (child) => {
      return textOf(child, names, depth + 1);
    },
    names
  );
};

const domainErrorMessages = () => {
  return tsFiles(srcDir).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf-8');
    if (!source.includes('DomainError(')) return [];
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true
    );
    const names = declarations(sourceFile);
    const found = [];
    const visit = (node) => {
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(sourceFile) === 'DomainError' &&
        node.arguments?.length >= 2
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile)
        );
        found.push({
          site: `${path.relative(srcDir, file)}:${line + 1}`,
          message: textOf(node.arguments[1], names),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  });
};

describe('error messages state the fact', () => {
  test('the check catches advice and passes a fact', () => {
    assert.equal(
      adviceIn("This API key is scoped to project 'a'. Mint a key for 'b'."),
      'tells the caller to act ("Mint")'
    );
    assert.equal(
      adviceIn('Create one with POST /tools first.'),
      'names a route'
    );
    assert.equal(
      adviceIn("This API key is scoped to project 'a' and cannot act on 'b'."),
      null
    );
  });

  test('no DomainError message names a route or tells the caller to act', () => {
    const advising = domainErrorMessages()
      .map(({ site, message }) => {
        const reason = adviceIn(message);
        return reason && `${site} ${reason}: ${message}`;
      })
      .filter(Boolean);
    assert.deepEqual(advising, []);
  });
});
