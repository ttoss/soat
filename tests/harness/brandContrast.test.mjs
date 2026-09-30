import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

import { normalizeSelector, readRules } from './cssRules.mjs';

/**
 * Text the brand paints on a colored fill must clear WCAG AA (4.5:1) in both
 * themes: the HTTP method badges of the API reference and the primary action
 * button, on the website, in the console and in the `soat-design` tokens they
 * follow.
 *
 * These pairs are where the dual theme is easy to get wrong. The fill shifts
 * hue per theme (Electric Blue in light, Core Cyan in dark) while a hard-coded
 * text color stays put, so a pair that passes in one theme silently fails in
 * the other. The primary action is one solid colour, the mark's hue, at rest
 * and on hover; a gradient there fails as not solid.
 *
 * The CSS reader handles the flat rule blocks these files use; a rule nested
 * in `@media` is read as unconditional, which is why only theme-scoped
 * selectors are consulted.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../..');

const WEBSITE_CSS = path.join(ROOT, 'packages/website/src/css/custom.css');

const DESIGN_DIR = path.join(ROOT, '.claude/skills/soat-design');

const DESIGN_COLORS = path.join(DESIGN_DIR, 'tokens/colors.css');

const DESIGN_BUTTON = path.join(DESIGN_DIR, 'components/core/Button.jsx');

const APP_CSS = path.join(ROOT, 'packages/app/src/index.css');

const APP_BUTTON = path.join(ROOT, 'packages/app/src/components/ui/button.tsx');

/** The console's themes: `.dark`, and the OS preference with no theme class. */
const APP_THEMES = {
  light: [':root'],
  dark: [':root', '.dark'],
  'dark-by-preference': [':root', ':root:not(.light)'],
};

/** WCAG 2.x AA for normal-size text; badge labels are 12px, buttons 16–20px. */
const MIN_RATIO = 4.5;

const METHODS = ['get', 'post', 'delete', 'put', 'patch'];

/** Sidebar badges of the API reference that are not HTTP methods. */
const NEUTRAL_BADGES = ['head', 'event', 'schema'];

const NAMED_COLORS = { white: '#ffffff', black: '#000000' };

/** Declarations of every rule matching any selector, later rules winning. */
const declarationsFor = (args) => {
  const wanted = args.selectors.map(normalizeSelector);
  return args.rules
    .filter((rule) => {
      return rule.selectors.some((selector) => {
        return wanted.includes(selector);
      });
    })
    .reduce((merged, rule) => {
      return { ...merged, ...rule.declarations };
    }, {});
};

const resolveVars = (args) => {
  let value = args.value;
  for (let depth = 0; depth < 10 && value.includes('var('); depth += 1) {
    value = value.replace(
      /var\((--[\w-]+)(?:,\s*([^()]*))?\)/g,
      (_whole, name, fallback) => {
        return args.vars[name] ?? fallback ?? `unresolved(${name})`;
      }
    );
  }
  return value;
};

const toRgb = (color) => {
  const hex = (NAMED_COLORS[color.toLowerCase()] ?? color).replace('#', '');
  const full =
    hex.length === 3
      ? [...hex]
          .map((digit) => {
            return digit + digit;
          })
          .join('')
      : hex;
  assert.match(full, /^[0-9a-f]{6}$/i, `not a solid color: ${color}`);
  return [0, 2, 4].map((offset) => {
    return parseInt(full.slice(offset, offset + 2), 16);
  });
};

/** Tailwind-style HSL channels (`282 44% 47%`) to a hex color. */
const hslToHex = (channels) => {
  const [h, s, l] = channels.split(/\s+/).map((part) => {
    return parseFloat(part);
  });
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const value = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => {
    return y - x;
  });
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The colors a fill paints: a solid color, or a gradient sampled in sRGB (how
 * browsers interpolate `linear-gradient` by default) between its stops.
 */
const fillSamples = (fill) => {
  const stops = [
    ...fill.matchAll(/#[0-9a-f]{3,8}\b|\bwhite\b|\bblack\b/gi),
  ].map((match) => {
    return toRgb(match[0]);
  });
  assert.ok(stops.length > 0, `no color found in fill: ${fill}`);
  if (stops.length === 1) return stops;
  const samples = [];
  for (let i = 0; i < stops.length - 1; i += 1) {
    for (let step = 0; step <= 10; step += 1) {
      const t = step / 10;
      samples.push(
        stops[i].map((channel, c) => {
          return Math.round(channel + (stops[i + 1][c] - channel) * t);
        })
      );
    }
  }
  return samples;
};

/** A fill that paints exactly one colour. */
const assertSolid = (args) => {
  assert.equal(
    fillSamples(args.fill).length,
    1,
    `${args.label} is not one solid colour: ${args.fill}`
  );
};

const worstRatio = (args) => {
  const text = toRgb(args.text);
  return Math.min(
    ...fillSamples(args.fill).map((sample) => {
      return contrast(text, sample);
    })
  );
};

const THEMES = {
  website: {
    light: { vars: [':root', "html[data-theme='light']"], prefix: null },
    dark: {
      vars: [':root', "html[data-theme='dark']"],
      prefix: "html[data-theme='dark']",
    },
  },
  design: {
    light: { vars: [':root'] },
    dark: { vars: [':root', ":root[data-theme='dark']"] },
  },
};

/** A rule's resolved declaration in one theme of the website. */
const websiteValue = (args) => {
  const rules = readRules(WEBSITE_CSS);
  const theme = THEMES.website[args.theme];
  const vars = declarationsFor({ rules, selectors: theme.vars });
  const scoped = theme.prefix
    ? [args.selector, `${theme.prefix} ${args.selector}`]
    : [args.selector];
  const declarations = declarationsFor({ rules, selectors: scoped });
  const raw = args.properties
    .map((property) => {
      return declarations[property];
    })
    .find((value) => {
      return value !== undefined;
    });
  assert.ok(raw, `${args.selector} declares none of ${args.properties}`);
  return resolveVars({ value: raw, vars });
};

/** A declaration a selector makes itself, or the fallback when it makes none. */
const websiteOwnValue = (args) => {
  try {
    return websiteValue({ ...args, properties: [args.property] });
  } catch {
    return args.fallback;
  }
};

const designVars = (theme) => {
  return declarationsFor({
    rules: readRules(DESIGN_COLORS),
    selectors: THEMES.design[theme].vars,
  });
};

const failures = (pairs) => {
  return pairs
    .map((pair) => {
      return { ...pair, ratio: worstRatio(pair) };
    })
    .filter((pair) => {
      return pair.ratio < MIN_RATIO;
    })
    .map((pair) => {
      return `${pair.label}: ${pair.text} on ${pair.fill} = ${pair.ratio.toFixed(2)}:1`;
    });
};

describe('website brand contrast', () => {
  for (const theme of ['light', 'dark']) {
    test(`website API method badges are legible (${theme})`, () => {
      const baseText = websiteValue({
        theme,
        selector: '.api-method > .menu__link::before',
        properties: ['color'],
      });
      const pairs = [...METHODS, ...NEUTRAL_BADGES].map((method) => {
        return {
          label: method,
          text: websiteOwnValue({
            theme,
            selector: `.${method} > .menu__link::before`,
            property: 'color',
            fallback: baseText,
          }),
          fill: websiteValue({
            theme,
            selector: `.${method} > .menu__link::before`,
            properties: ['background-color', 'background'],
          }),
        };
      });

      assert.deepEqual(failures(pairs), []);
    });

    test(`website primary button is one legible solid colour (${theme})`, () => {
      const rest = websiteValue({
        theme,
        selector: '.button--primary',
        properties: ['background', 'background-color'],
      });
      const pairs = ['.button--primary', '.button--primary:hover'].map(
        (selector) => {
          return {
            label: selector,
            fill: websiteOwnValue({
              theme,
              selector,
              property: 'background',
              fallback: rest,
            }),
            text: websiteValue({ theme, selector, properties: ['color'] }),
          };
        }
      );

      for (const pair of pairs) assertSolid(pair);
      assert.deepEqual(failures(pairs), []);
    });
  }

  /**
   * `docusaurus-theme-openapi-docs` declares its own `--openapi-code-*` on
   * `:root` in a stylesheet that loads after `custom.css`, so a light value
   * declared on `:root` here never reaches the page. The light fills win only
   * from a more specific selector.
   */
  test('website light method fills outrank the API theme defaults', () => {
    const lightBlock = declarationsFor({
      rules: readRules(WEBSITE_CSS),
      selectors: ["html[data-theme='light']"],
    });
    const missing = [
      '--openapi-code-green',
      '--openapi-code-red',
      '--openapi-code-blue',
      '--openapi-code-orange',
    ].filter((name) => {
      return lightBlock[name] === undefined;
    });

    assert.deepEqual(missing, []);
  });
});

describe('design-token brand contrast', () => {
  for (const theme of ['light', 'dark']) {
    test(`design tokens: method badges are legible (${theme})`, () => {
      const vars = designVars(theme);
      const pairs = METHODS.map((method) => {
        return {
          label: `--method-${method}`,
          text: resolveVars({ value: vars['--method-fg'] ?? '', vars }),
          fill: resolveVars({ value: vars[`--method-${method}`] ?? '', vars }),
        };
      });

      assert.deepEqual(failures(pairs), []);
    });

    test(`design tokens: the action colour is solid and legible (${theme})`, () => {
      const vars = designVars(theme);
      const pairs = ['--color-action', '--color-action-hover'].map((name) => {
        assert.ok(vars[name], `${name} is not defined`);
        assert.ok(vars['--text-on-action'], '--text-on-action is not defined');
        return {
          label: name,
          text: resolveVars({ value: vars['--text-on-action'], vars }),
          fill: resolveVars({ value: vars[name], vars }),
        };
      });

      for (const pair of pairs) assertSolid(pair);
      assert.deepEqual(failures(pairs), []);
    });
  }

  test('the design-system Button paints the action tokens', () => {
    const source = fs.readFileSync(DESIGN_BUTTON, 'utf-8');

    assert.match(source, /background: 'var\(--color-action\)'/);
    assert.match(source, /'var\(--color-action-hover\)'/);
    assert.match(source, /color: 'var\(--text-on-action\)'/);
  });
});

describe('console brand contrast', () => {
  for (const theme of ['light', 'dark', 'dark-by-preference']) {
    test(`console action colour is legible (${theme})`, () => {
      const vars = declarationsFor({
        rules: readRules(APP_CSS),
        selectors: APP_THEMES[theme],
      });
      const channel = (name) => {
        assert.ok(vars[name], `${name} is not defined for ${theme}`);
        return hslToHex(vars[name]);
      };
      const pairs = ['--action', '--action-hover'].map((name) => {
        return {
          label: name,
          text: channel('--action-foreground'),
          fill: channel(name),
        };
      });

      assert.deepEqual(failures(pairs), []);
    });
  }

  test('the console action Button paints the action tokens', () => {
    const source = fs.readFileSync(APP_BUTTON, 'utf-8');

    assert.match(
      source,
      /action:\s*'[^']*\bbg-action\b[^']*\btext-action-foreground\b[^']*\bhover:bg-action-hover\b/
    );
  });
});
