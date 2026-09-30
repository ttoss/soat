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

export type HeroCopy = {
  /** The headline up to its emphasised ending. */
  title: string;
  emphasis: string;
  subtitle: string;
};

export const HERO: HeroCopy = {
  title: 'Everything an agent needs,',
  emphasis: 'except the model.',
  subtitle:
    'Memory, knowledge, permissions, orchestration, evaluations and traces in one open-source server you run yourself. The model comes from the provider you choose, hosted or local.',
};

/** The services a SOAT install does not need beside it. */
export const NOT_WIRED = [
  'a message queue',
  'a vector database',
  'an auth server',
  'a trace collector',
  'a scheduler',
];

export type HomeMeta = {
  /** The whole `<title>`: the homepage skips the site's " | SOAT" suffix. */
  title: string;
  description: string;
};

export const HOME_META: HomeMeta = {
  title: 'SOAT — open-source infrastructure for production-ready AI agents',
  description:
    'Memory, knowledge, permissions, orchestration, evaluations and traces for AI agents in one open-source server you run yourself. Bring any model.',
};
