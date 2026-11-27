import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  loadPermissionsFiles,
  renderPermissionsPage,
} from './generatePermissionsPage';
import { escapeMdx } from './mdx';

const page = renderPermissionsPage();

test('every description is escaped for MDX', () => {
  for (const { operations, srnPatterns } of loadPermissionsFiles()) {
    for (const { action, description } of [
      ...operations,
      ...(srnPatterns ?? []).map((p) => {
        return { action: p.pattern, description: p.description };
      }),
    ]) {
      assert.ok(
        page.includes(`| \`${action}\` | ${escapeMdx(description)} |`),
        `unescaped description for ${action}`
      );
    }
  }
});
