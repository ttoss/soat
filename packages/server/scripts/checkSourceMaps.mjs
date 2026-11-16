// Fails when a dist/*.mjs.map does not describe its bundle: for each mapping
// that starts an identifier in the bundle, the source it points at must start
// with the same identifier. Run by `build`, so the image build fails on it.
import * as fs from 'node:fs';
import { SourceMap } from 'node:module';
import * as path from 'node:path';

const MIN_MATCH_RATIO = 0.95;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const IDENTIFIER_AT = /^[A-Za-z_$][\w$]*/;
// The bundler renames colliding bindings (`log` → `log$12`) and, with
// `topLevelVar`, rewrites top-level `const`/`let` to `var`.
const RENAME_SUFFIX = /\$\d+$/;
const REWRITTEN = new Set(['var']);

export const checkSourceMap = ({ code, map }) => {
  const sourceMap = new SourceMap(map);
  const sources = new Map(
    map.sources.map((source, index) => {
      return [
        path.resolve('/', source),
        (map.sourcesContent?.[index] ?? '').split('\n'),
      ];
    })
  );
  const originalNameAt = ({ lineNumber, index }) => {
    const entry = sourceMap.findEntry(lineNumber, index);
    if (entry?.generatedLine !== lineNumber) return undefined;
    if (entry.generatedColumn !== index) return undefined;
    const original = sources.get(path.resolve('/', entry.originalSource));
    if (!original) return undefined;
    const text = original[entry.originalLine]?.slice(entry.originalColumn);
    return text?.match(IDENTIFIER_AT)?.[0] ?? '';
  };
  let checked = 0;
  let matched = 0;
  for (const [lineNumber, line] of code.split('\n').entries()) {
    for (const { 0: token, index } of line.matchAll(IDENTIFIER)) {
      if (REWRITTEN.has(token)) continue;
      const originalName = originalNameAt({ lineNumber, index });
      if (originalName === undefined) continue;
      checked += 1;
      if (originalName === token.replace(RENAME_SUFFIX, '')) matched += 1;
    }
  }
  return { checked, matched, ratio: checked ? matched / checked : 0 };
};

const main = () => {
  const dist = path.resolve(process.argv[2] ?? 'dist');
  const bundles = fs.readdirSync(dist).filter((file) => {
    return file.endsWith('.mjs');
  });
  let failed = false;
  for (const bundle of bundles) {
    const mapFile = path.join(dist, `${bundle}.map`);
    if (!fs.existsSync(mapFile)) {
      console.error(`${bundle}: no source map`);
      failed = true;
      continue;
    }
    const { checked, matched, ratio } = checkSourceMap({
      code: fs.readFileSync(path.join(dist, bundle), 'utf8'),
      map: JSON.parse(fs.readFileSync(mapFile, 'utf8')),
    });
    const verdict = ratio >= MIN_MATCH_RATIO ? 'ok' : 'MISMATCH';
    console.log(`${bundle}: ${matched}/${checked} mappings match (${verdict})`);
    if (verdict !== 'ok') failed = true;
  }
  if (bundles.length === 0) {
    console.error(`no bundles in ${dist}`);
    failed = true;
  }
  if (failed) process.exit(1);
};

if (import.meta.url === `file://${process.argv[1]}`) main();
