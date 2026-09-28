/**
 * Homepage content that more than one band renders, or that a test pins.
 */

export type PrimaryAction = {
  label: string;
  to: string;
};

export const PRIMARY_ACTION: PrimaryAction = {
  label: 'Run it locally',
  to: '/docs/getting-started',
};

export type QuickstartCommand = {
  title: string;
  lines: string[];
};

export const QUICKSTART_COMMANDS: QuickstartCommand[] = [
  {
    title: 'Create the agent',
    lines: [
      'soat create-agent \\',
      '  --project-id "$PROJECT_ID" \\',
      '  --ai-provider-id "$PROVIDER_ID" \\',
      '  --name support-bot \\',
      '  --instructions "You are a helpful support assistant."',
    ],
  },
  {
    title: 'Open a session',
    lines: [
      'soat create-session \\',
      '  --agent-id "$AGENT_ID" \\',
      '  --name user-chat-42',
    ],
  },
  {
    title: 'Add the message',
    lines: [
      'soat add-session-message \\',
      '  --session-id "$SESSION_ID" \\',
      '  --message "Hello!"',
    ],
  },
  {
    title: 'Generate the answer',
    lines: [
      'soat generate-session-response \\',
      '  --session-id "$SESSION_ID" \\',
      '  --wait true',
    ],
  },
];
