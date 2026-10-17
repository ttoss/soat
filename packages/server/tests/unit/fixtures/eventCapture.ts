import { eventBus, type SoatEvent } from 'src/lib/eventBus';

/** Long enough for an emit behind a retried lookup; short of the test timeout. */
const WAIT_MS = 5000;

/**
 * Runs `action` and answers the events of `type` it caused that `where`
 * accepts, once `count` have arrived. An emit that first reads its record
 * lands after the response, so arrival is awaited rather than assumed.
 */
export const captureEvents = async (args: {
  type: string;
  where: (event: SoatEvent) => boolean;
  action: () => Promise<unknown>;
  count?: number;
}): Promise<SoatEvent[]> => {
  const wanted = args.count ?? 1;
  const seen: SoatEvent[] = [];
  let arrived: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const handler = (event: SoatEvent) => {
    if (event.type !== args.type) return;
    if (!args.where(event)) return;
    seen.push(event);
    if (seen.length >= wanted) arrived();
  };

  let timer: NodeJS.Timeout | undefined;
  eventBus.on('soat:event', handler);
  try {
    await args.action();
    await Promise.race([
      done,
      new Promise((resolve) => {
        timer = setTimeout(resolve, WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    eventBus.off('soat:event', handler);
  }
  return seen;
};

/** A record as it reads on the wire: dates serialized, `undefined` dropped. */
export const asWire = (value: object): unknown => {
  return JSON.parse(JSON.stringify(value));
};
