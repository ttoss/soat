import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SOAT_EVENT_TYPES, SOAT_EVENTS } from 'src/lib/soatEvents';

/**
 * The compiler already owns most of this contract: `emitResourceEvent` takes an
 * event name drawn from the registry entry for the `resourceType` it is given,
 * so a typo or a rename is a type error at the emit site.
 *
 * The one hole a type cannot close is the deliberate escape hatch.
 * `emitCustomEvent` accepts an arbitrary name because an orchestration
 * `emit_event` node emits whatever the template author wrote — a real contract
 * SOAT does not get to narrow. Nothing stops a *platform* emit site from
 * reaching for it too, and that would put an unregistered event back on the bus
 * with no compiler complaint and no entry in the generated webhook reference.
 *
 * This check is static because the failure is an absence: the event still gets
 * delivered, so no behavioral test goes red — only the docs and the type union
 * quietly stop describing what the platform emits.
 */

const SRC_DIR = join(__dirname, '../../../../src');

/** The only module allowed to emit an unregistered, user-authored name. */
const CUSTOM_EMIT_ALLOWLIST = ['lib/orchestrationEmitEventNode.ts'];

// A `<namespace>.*` pattern is exactly one resource's events only while every
// namespace is its resource type's plural. `audit` is the IAM resource type of
// an audit entry.
const IRREGULAR_PLURALS: Record<string, string> = {
  audit: 'audit_entries',
  memory: 'memories',
};

const eventNamespace = (resourceType: string): string => {
  return IRREGULAR_PLURALS[resourceType] ?? `${resourceType}s`;
};

const collectSourceFiles = (dir: string, prefix = ''): string[] => {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;

    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full, relative));
      continue;
    }

    if (entry.endsWith('.ts')) found.push(relative);
  }

  return found;
};

describe('event type contract', () => {
  test('only the orchestration emit_event node uses emitCustomEvent', () => {
    const offenders = collectSourceFiles(SRC_DIR).filter((relative) => {
      if (relative === 'lib/eventBus.ts') return false;
      if (CUSTOM_EMIT_ALLOWLIST.includes(relative)) return false;
      // A call, not a mention: `soatEvents.ts` names it in a doc comment.
      return readFileSync(join(SRC_DIR, relative), 'utf-8').includes(
        'emitCustomEvent('
      );
    });

    expect(offenders).toEqual([]);
  });

  // Each carries the generation record as its GET answers it; a second emit
  // site would decide that shape a second time.
  test('only generationEvents.ts emits a generation lifecycle event', () => {
    const lifecycle = /'generations\.(completed|failed|requires_action)'/;
    const offenders = collectSourceFiles(SRC_DIR).filter((relative) => {
      const source = readFileSync(join(SRC_DIR, relative), 'utf-8');
      return source.includes('emitResourceEvent(') && lifecycle.test(source);
    });

    expect(offenders).toEqual(['lib/generationEvents.ts']);
  });

  test('every registered name is <plural of its resource type>.<verb>', () => {
    const offenders = Object.entries(SOAT_EVENTS).flatMap(
      ([resourceType, events]) => {
        const name = new RegExp(`^${eventNamespace(resourceType)}\\.[a-z_]+$`);
        return Object.keys(events).filter((type) => {
          return !name.test(type);
        });
      }
    );

    expect(offenders).toEqual([]);
  });

  test('every registered resource type carries at least one event', () => {
    const empty = Object.entries(SOAT_EVENTS)
      .filter(([, events]) => {
        return Object.keys(events).length === 0;
      })
      .map(([resourceType]) => {
        return resourceType;
      });

    expect(empty).toEqual([]);
  });

  test('every registered event carries a non-empty description', () => {
    for (const events of Object.values(SOAT_EVENTS)) {
      for (const [name, description] of Object.entries(events)) {
        expect(`${name}: ${description}`).toMatch(/: .+\.$/);
      }
    }
  });

  test('SOAT_EVENT_TYPES lists exactly the registry entries', () => {
    const flattened = Object.values(SOAT_EVENTS).flatMap((events) => {
      return Object.keys(events);
    });
    expect([...SOAT_EVENT_TYPES].sort()).toEqual(flattened.sort());
  });
});
