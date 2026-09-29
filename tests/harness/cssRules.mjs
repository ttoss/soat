import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A reader for the flat CSS the brand files use: rule blocks of declarations,
 * optionally wrapped in one at-rule. It is not a CSS parser; a rule nested in
 * an at-rule reads as unconditional unless the at-rule is split out first
 * with `splitAtRule`.
 */

export const normalizeSelector = (selector) => {
  return selector.trim().replace(/\s+/g, ' ').replace(/"/g, "'");
};

export const stripComments = (css) => {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
};

/** Every innermost `selectors { declarations }` block of `css`. */
export const parseRules = (css) => {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (match) => {
      const selectorText = match[1].split(';').pop();
      const declarations = {};
      for (const declaration of match[2].split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        declarations[declaration.slice(0, colon).trim()] = declaration
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, ' ');
      }
      return {
        selectors: selectorText.split(',').map(normalizeSelector),
        declarations,
      };
    }
  );
};

export const readRules = (file) => {
  return parseRules(fs.readFileSync(file, 'utf-8'));
};

/**
 * Separates the bodies of every at-rule whose prelude matches `prelude` from
 * the rest of the stylesheet, matching braces so nested rules stay inside.
 */
export const splitAtRule = (args) => {
  const css = stripComments(args.css);
  const inside = [];
  let outside = '';
  let cursor = 0;
  for (const match of css.matchAll(args.prelude)) {
    if (match.index < cursor) continue;
    const open = css.indexOf('{', match.index);
    let depth = 1;
    let close = open + 1;
    for (; close < css.length && depth > 0; close += 1) {
      if (css[close] === '{') depth += 1;
      if (css[close] === '}') depth -= 1;
    }
    outside += css.slice(cursor, match.index);
    inside.push(css.slice(open + 1, close - 1));
    cursor = close;
  }
  return { inside, outside: outside + css.slice(cursor) };
};

export const listCss = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listCss(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
};
