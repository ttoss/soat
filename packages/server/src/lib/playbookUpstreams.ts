import createDebug from 'debug';

import { db } from '../db';
import {
  parseField,
  type PlaybookDefinition,
  type PlaybookNode,
} from './playbookDefinition';
import { nodesByKey } from './playbookGraph';
import { fieldExists } from './playbookValidation';
import type { ValidationProblem } from './validationProblems';

const log = createDebug('soat:playbooks');

type PlaybookDefinitionRow = {
  id?: unknown;
  publicId: string;
  definition: object;
};

/** A stored definition: one the wire already read, so its shape holds. */
const storedDefinition = (row: PlaybookDefinitionRow): PlaybookDefinition => {
  return row.definition as PlaybookDefinition;
};

const projectPlaybooks = async (args: {
  projectId: number;
}): Promise<Map<string, PlaybookDefinitionRow>> => {
  const rows = await db.Playbook.findAll({
    where: { projectId: args.projectId },
    attributes: ['id', 'publicId', 'definition'],
  });
  return new Map(
    rows.map((row) => {
      return [row.publicId, row];
    })
  );
};

/** Whether `from`, through declared upstreams, reaches the playbook `target`. */
const reaches = (args: {
  from: string;
  target: string;
  byId: Map<string, PlaybookDefinitionRow>;
}): boolean => {
  const seen = new Set<string>();
  const stack = [args.from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === args.target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = args.byId.get(id);
    for (const upstream of row ? (storedDefinition(row).upstreams ?? []) : []) {
      stack.push(upstream.playbook_id);
    }
  }
  return false;
};

/** The node each upstream node pulls, in the upstream's current version. */
const pulledNodes = (args: {
  definition: PlaybookDefinition;
  resolved: Map<string, PlaybookDefinition>;
  problems: ValidationProblem[];
}): Map<string, PlaybookNode> => {
  const pulled = new Map<string, PlaybookNode>();
  for (const [index, node] of args.definition.nodes.entries()) {
    if (!node.upstream) continue;
    const upstream = args.resolved.get(node.upstream.name);
    if (!upstream) continue;
    const source = nodesByKey({ definition: upstream }).get(
      node.upstream.node_id
    );
    if (source) {
      pulled.set(node.id, source);
    } else {
      args.problems.push({
        code: 'MISSING_NODE',
        path: `definition.nodes[${index}].upstream.node_id`,
        message: `Node '${node.id}' pulls node '${node.upstream.node_id}', which upstream '${node.upstream.name}' does not declare.`,
      });
    }
  }
  return pulled;
};

/** Every input reading an upstream node reads a field the pulled node produces. */
const pulledFieldProblems = (args: {
  definition: PlaybookDefinition;
  pulled: Map<string, PlaybookNode>;
}): ValidationProblem[] => {
  return args.definition.nodes.flatMap((node, nodeIndex) => {
    return node.inputs.flatMap((input, index) => {
      if (input.source === 'manual') return [];
      const source = args.pulled.get(input.source.node_id);
      const field = parseField({ field: input.source.field });
      if (!source || !field || fieldExists({ source, field })) return [];
      return [
        {
          code: 'UNKNOWN_FIELD',
          path: `definition.nodes[${nodeIndex}].inputs[${index}].source.field`,
          message: `Input '${input.name}' of node '${node.id}' reads '${input.source.field}', which the node '${input.source.node_id}' pulls does not produce.`,
        },
      ];
    });
  });
};

/**
 * What a definition's upstreams refuse, read against the project's playbooks
 * as they stand: each names a playbook of the project, none reads the
 * playbook back, and every pulled node and field exists in the upstream's
 * current version. `playbookId` is the playbook being updated; a new one is
 * read by nobody yet.
 */
export const playbookUpstreamProblems = async (args: {
  definition: PlaybookDefinition;
  projectId: number;
  playbookId?: string;
}): Promise<ValidationProblem[]> => {
  const { definition } = args;
  if (!definition.upstreams) return [];
  log('playbookUpstreamProblems: projectId=%d', args.projectId);

  const byId = await projectPlaybooks(args);
  const problems: ValidationProblem[] = [];
  const resolved = new Map<string, PlaybookDefinition>();

  for (const [index, upstream] of definition.upstreams.entries()) {
    const path = `definition.upstreams[${index}].playbook_id`;
    const row = byId.get(upstream.playbook_id);
    if (!row) {
      problems.push({
        code: 'UNKNOWN_UPSTREAM',
        path,
        message: `Upstream '${upstream.name}' names playbook '${upstream.playbook_id}', which the project does not hold.`,
      });
    } else if (
      args.playbookId !== undefined &&
      reaches({ from: upstream.playbook_id, target: args.playbookId, byId })
    ) {
      problems.push({
        code: 'UPSTREAM_CYCLE',
        path,
        message: `Upstream '${upstream.name}' reads this playbook back through its own upstreams.`,
      });
    } else if (!resolved.has(upstream.name)) {
      resolved.set(upstream.name, storedDefinition(row));
    }
  }

  const pulled = pulledNodes({ definition, resolved, problems });
  return [...problems, ...pulledFieldProblems({ definition, pulled })];
};

/** The playbooks whose current definition declares `publicId` an upstream. */
export const playbookDependents = async (args: {
  projectId: number;
  publicId: string;
}): Promise<string[]> => {
  const byId = await projectPlaybooks(args);
  return [...byId.values()]
    .filter((row) => {
      return (storedDefinition(row).upstreams ?? []).some((upstream) => {
        return upstream.playbook_id === args.publicId;
      });
    })
    .map((row) => {
      return row.publicId;
    });
};
