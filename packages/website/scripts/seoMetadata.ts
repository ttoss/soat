import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * What a search result shows of a page: its `<title>` and its meta
 * description. Google cuts titles near 60 characters and descriptions near
 * 160, and it collapses pages that share either into one, so every built page
 * carries its own pair inside these bounds. `checkSeoMetadata.ts` holds the
 * build to them.
 */

export const TITLE_MAX = 65;

export const DESCRIPTION_MIN = 50;

export const DESCRIPTION_MAX = 160;

export type PageMeta = {
  path: string;
  title: string;
  description: string;
};

/** Markdown and inline HTML reduced to the words a snippet shows. */
export const plainText = (args: { markdown: string }): string => {
  return args.markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/`/g, '')
    // Emphasis markers only: an underscore inside a name (`guardrail_ids`)
    // is part of the name.
    .replace(/(?<![\w*])(\*\*|__|\*|_)(?=\S)([^*_]*?\S)\1(?![\w*])/g, '$2')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
};

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9`"'(])/;

/**
 * A description inside the bounds, built from `text`: whole sentences while
 * they fit, else the first sentence cut at a word. A text too short to stand
 * alone is completed with `context`, which names what the page is.
 */
export const fitDescription = (args: {
  text: string;
  context: string;
}): string => {
  const sentences = args.text.trim().split(SENTENCE_END).filter(Boolean);
  let fitted = '';
  for (const sentence of sentences) {
    const next = fitted ? `${fitted} ${sentence}` : sentence;
    if (next.length > DESCRIPTION_MAX) break;
    fitted = next;
  }
  if (!fitted && sentences.length > 0) {
    const cut = sentences[0].slice(0, DESCRIPTION_MAX - 1);
    fitted = `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:\s]+$/, '')}…`;
  }
  if (fitted.length < DESCRIPTION_MIN) {
    const sentence = fitted && !/[.!?…]$/.test(fitted) ? `${fitted}.` : fitted;
    const joined = [sentence, args.context].filter(Boolean).join(' ');
    if (joined.length <= DESCRIPTION_MAX) return joined;
  }
  return fitted;
};

const duplicates = (args: {
  pages: PageMeta[];
  key: 'title' | 'description';
  label: string;
}): string[] => {
  const byValue = new Map<string, string[]>();
  for (const page of args.pages) {
    const value = page[args.key];
    if (!value) continue;
    byValue.set(value, [...(byValue.get(value) ?? []), page.path]);
  }
  return [...byValue.entries()]
    .filter(([, paths]) => {
      return paths.length > 1;
    })
    .map(([value, paths]) => {
      return `duplicate ${args.label} "${value}": ${paths.join(', ')}`;
    });
};

/** Every page whose title or description a search result would show wrong. */
export const metadataViolations = (args: { pages: PageMeta[] }): string[] => {
  const perPage = args.pages.flatMap((page) => {
    const found: string[] = [];
    if (!page.title) found.push(`no title: ${page.path}`);
    if (page.title.length > TITLE_MAX) {
      found.push(`title over ${TITLE_MAX} characters: ${page.path}`);
    }
    if (!page.description) found.push(`no description: ${page.path}`);
    else if (page.description.length < DESCRIPTION_MIN) {
      found.push(
        `description under ${DESCRIPTION_MIN} characters: ${page.path}`
      );
    } else if (page.description.length > DESCRIPTION_MAX) {
      found.push(
        `description over ${DESCRIPTION_MAX} characters: ${page.path}`
      );
    }
    return found;
  });
  return [
    ...duplicates({ pages: args.pages, key: 'title', label: 'title' }),
    ...perPage,
    ...duplicates({
      pages: args.pages,
      key: 'description',
      label: 'description',
    }),
  ];
};

const decode = (text: string): string => {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
};

/** An attribute of a minified tag, quoted or not. */
const attribute = (args: { tag: string; name: string }): string | undefined => {
  const match = new RegExp(
    `\\s${args.name}=(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`
  ).exec(args.tag);
  return match ? decode(match[1] ?? match[2] ?? match[3]) : undefined;
};

/** The title and description of one built HTML page, or none for a redirect. */
export const readPageMeta = (args: {
  html: string;
  path: string;
}): PageMeta | undefined => {
  const head = args.html.slice(0, args.html.indexOf('</head>'));
  if (/http-equiv=["']?refresh/i.test(head)) return undefined;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(head);
  const description = [...head.matchAll(/<meta\s[^>]*>/g)]
    .map((match) => {
      return match[0];
    })
    .find((tag) => {
      return attribute({ tag, name: 'name' }) === 'description';
    });
  return {
    path: args.path,
    title: title ? decode(title[1]).trim() : '',
    description: description
      ? (attribute({ tag: description, name: 'content' }) ?? '')
      : '',
  };
};

/** Every page in a Docusaurus build directory. */
export const readBuiltPages = (args: { buildDir: string }): PageMeta[] => {
  const walk = (dir: string): string[] => {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.html') && entry.name !== '404.html'
        ? [full]
        : [];
    });
  };
  return walk(args.buildDir)
    .map((file) => {
      const route = `/${path.relative(args.buildDir, file)}`
        .replace(/\/index\.html$/, '')
        .replace(/\.html$/, '');
      return readPageMeta({
        html: fs.readFileSync(file, 'utf8'),
        path: route || '/',
      });
    })
    .filter((page): page is PageMeta => {
      return page !== undefined;
    })
    .sort((a, b) => {
      return a.path.localeCompare(b.path);
    });
};
