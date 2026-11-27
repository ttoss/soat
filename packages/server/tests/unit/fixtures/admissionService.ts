/**
 * A deployment's admission service on localhost: every question is genuinely
 * serialized and signed, and what it received is the observable. A question
 * outside the published `AdmissionRequest` fails `undeclare`.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type OnUnavailable, registerAdmission } from 'src/lib/admission';
import {
  signatureHeader,
  verifyTimestampedSignature,
} from 'src/lib/hmacSignature';

import { assertMatchesComponentSchema } from '../openapiContract';

const SECRET = 'admission-signing-secret';

/** An address nothing listens on. */
export const DOWN_URL = 'http://127.0.0.1:1/admit';

export type Asked = { body: Record<string, unknown>; signed: boolean };

/** `stall` sends the head and part of the body, then never finishes it. */
export type Reply = { status: number; body: unknown; stall?: boolean };

export const ADMIT: Reply = { status: 204, body: null };

export const REFUSAL: Reply = {
  status: 409,
  body: {
    error: {
      code: 'PLAN_LIMIT_REACHED',
      message: 'The plan allows 3 of these.',
      meta: { limit: 3 },
    },
  },
};

/** A refusal carrying the service's own advice. */
export const HINTED_REFUSAL: Reply = {
  status: 409,
  body: {
    error: {
      code: 'PLAN_LIMIT_REACHED',
      message: 'The plan allows 3 of these.',
      hint: 'Upgrade the plan to create more of these.',
    },
  },
};

/** A status no operation declares, under a lowercase code. */
export const PAYMENT_REFUSAL: Reply = {
  status: 402,
  body: {
    error: {
      code: 'insufficient_credit',
      message: 'The account has no credit left.',
      meta: { balance: 0 },
    },
  },
};

export type AdmissionService = {
  /** Every question received since the last `declare`, oldest first. */
  asked: Asked[];
  /** What the service answers, or a function of how many it was asked before. */
  reply: Reply | ((index: number) => Reply);
  /** Registers the service for `actions`, at its own URL unless `url` names another. */
  declare: (args: {
    actions: string[];
    url?: string;
    timeoutMs?: number;
    onUnavailable?: OnUnavailable;
  }) => void;
  /** Unregisters; call it after every test that declared. Throws when a question broke the contract. */
  undeclare: () => void;
  close: () => Promise<void>;
};

type State = Pick<AdmissionService, 'asked' | 'reply'> & {
  violations: string[];
};

const contractViolation = (body: unknown): string | null => {
  try {
    assertMatchesComponentSchema({ schema: 'AdmissionRequest', value: body });
    const principal =
      typeof body === 'object' && body !== null && 'principal' in body
        ? body.principal
        : undefined;
    assertMatchesComponentSchema({
      schema: 'AdmissionPrincipal',
      value: principal,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const answer = (args: { state: State }) => {
  const { state } = args;
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const header = req.headers[signatureHeader().toLowerCase()];
      const body = JSON.parse(raw);
      const violation = contractViolation(body);
      if (violation) state.violations.push(violation);
      state.asked.push({
        body,
        signed:
          typeof header === 'string' &&
          verifyTimestampedSignature({
            secret: SECRET,
            rawBody: raw,
            header,
          }) !== null,
      });
      const reply =
        typeof state.reply === 'function'
          ? state.reply(state.asked.length - 1)
          : state.reply;
      const text = reply.body === null ? '' : JSON.stringify(reply.body);
      if (reply.stall) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.write(text.slice(0, 1));
        return;
      }
      res.writeHead(reply.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    });
  });
};

export const startAdmissionService = async (): Promise<AdmissionService> => {
  const state: State = { asked: [], reply: ADMIT, violations: [] };
  const server = answer({ state });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/admit`;

  return Object.assign(state, {
    declare: (args: {
      actions: string[];
      url?: string;
      timeoutMs?: number;
      onUnavailable?: OnUnavailable;
    }) => {
      state.asked.length = 0;
      registerAdmission({
        registration: {
          handler: {
            url: args.url ?? baseUrl,
            secret: SECRET,
            timeoutMs: args.timeoutMs ?? 2000,
          },
          actions: new Set(args.actions),
          onUnavailable: args.onUnavailable ?? 'refuse',
        },
      });
    },
    undeclare: () => {
      registerAdmission({ registration: null });
      state.reply = ADMIT;
      const violations = state.violations.splice(0);
      if (violations.length > 0) {
        throw new Error(
          `The runtime asked outside AdmissionRequest:\n${violations.join('\n')}`
        );
      }
    },
    close: () => {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  });
};
