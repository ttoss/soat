import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkSource } from './checkClientExamples';

const IMPORTS =
  "import Tabs from '@theme/Tabs';\nimport TabItem from '@theme/TabItem';\n";

const tab = (value: string, lang: string, body: string) => {
  return `<TabItem value="${value}" label="${value}">\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n</TabItem>`;
};

const full = [
  '<Tabs groupId="client">',
  tab('cli', 'bash', 'soat list-agents'),
  tab('sdk', 'ts', 'await soat.agents.listAgents({});'),
  tab('curl', 'bash', 'curl https://api.example.com/api/v1/agents'),
  '</Tabs>',
].join('\n');

test('a complete client tab set passes', () => {
  assert.deepEqual(checkSource({ file: 'modules/a.md', source: IMPORTS + full }), []);
});

test('a call outside client tabs fails', () => {
  const problems = checkSource({
    file: 'advanced/a.md',
    source: '```bash\ncurl https://api.example.com/api/v1/agents\n```\n',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /curl example outside/);
});

test('a missing or misordered tab fails', () => {
  const source =
    IMPORTS +
    [
      '<Tabs groupId="client">',
      tab('cli', 'bash', 'soat list-agents'),
      tab('curl', 'bash', 'curl https://x/api/v1/agents'),
      '</Tabs>',
    ].join('\n');
  const problems = checkSource({ file: 'modules/a.md', source });
  assert.match(problems.join('\n'), /expected exactly \[cli, sdk, curl\]/);
});

test('an example in the wrong tab fails', () => {
  const source = IMPORTS + full.replace('soat list-agents', 'curl https://x');
  assert.match(
    checkSource({ file: 'modules/a.md', source }).join('\n'),
    /curl example inside the "cli" tab/
  );
});

test('a module page with no client tabs fails', () => {
  assert.match(
    checkSource({ file: 'modules/a.md', source: '# A\n' }).join('\n'),
    /no <Tabs groupId="client">/
  );
});

test('a conceptual page with no calls passes', () => {
  assert.deepEqual(
    checkSource({ file: 'advanced/a.md', source: '```json\n{}\n```\n' }),
    []
  );
});
