/**
 * Generates packages/website/docs/permissions.md from the permissions
 * JSON files in packages/server/src/permissions/.
 *
 * Run with: pnpm tsx scripts/generatePermissionsPage.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const PERMISSIONS_DIR = path.resolve(__dirname, '../../server/src/permissions');
const OUTPUT_FILE = path.resolve(__dirname, '../docs/permissions.md');

// ── Types ──────────────────────────────────────────────────────────────────

interface PermissionOperation {
  operationId: string;
  action: string;
  description: string;
}

interface SrnPattern {
  pattern: string;
  description: string;
}

interface PermissionsJson {
  module: string;
  operations: PermissionOperation[];
  srnPatterns?: SrnPattern[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const toTitleCase = (kebab: string): string => {
  return kebab
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
};

/** Load all permissions JSON files, sorted by module name. */
const loadPermissionsFiles = (): PermissionsJson[] => {
  return fs
    .readdirSync(PERMISSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      return JSON.parse(
        fs.readFileSync(path.join(PERMISSIONS_DIR, f), 'utf-8')
      ) as PermissionsJson;
    });
};

// ── Renderer ───────────────────────────────────────────────────────────────

const renderPermissionsTable = (operations: PermissionOperation[]): string => {
  const header = [
    '| Permission | Description |',
    '| ---------- | ----------- |',
  ];

  const rows = operations.map(
    ({ action, description }) => `| \`${action}\` | ${description} |`
  );

  return [...header, ...rows].join('\n');
};

const renderSrnPatternsTable = (patterns: SrnPattern[]): string => {
  const header = ['| Pattern | Description |', '| ------- | ----------- |'];
  const rows = patterns.map(
    ({ pattern, description }) => `| \`${pattern}\` | ${description} |`
  );
  return [...header, ...rows].join('\n');
};

// ── Main ───────────────────────────────────────────────────────────────────

const main = () => {
  const permissionsFiles = loadPermissionsFiles();

  const sections: string[] = [
    '---',
    'sidebar_position: 100',
    '---',
    '',
    '# Permissions Reference',
    '',
    '> This page is auto-generated. Do not edit manually — run `pnpm generate-permissions-page` to regenerate.',
    '',
    'Complete list of all IAM permission actions, grouped by module. Use these strings in the `action` field of a policy statement.',
    '',
    'See [IAM & Policies](./modules/iam) for how policies are evaluated.',
  ];

  for (const { module, operations, srnPatterns } of permissionsFiles) {
    const moduleLabel = toTitleCase(module);

    sections.push('');
    sections.push(`## ${moduleLabel}`);
    sections.push('');
    sections.push(renderPermissionsTable(operations));

    if (srnPatterns && srnPatterns.length > 0) {
      sections.push('');
      sections.push('### Resource Identifiers');
      sections.push('');
      sections.push(renderSrnPatternsTable(srnPatterns));
    }
  }

  sections.push('');

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, sections.join('\n'), 'utf-8');
  console.log(`✓ Generated ${OUTPUT_FILE}`);
};

main();
