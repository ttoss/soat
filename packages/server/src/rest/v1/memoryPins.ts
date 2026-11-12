import { resourcePins } from './resourcePins';

/**
 * The pins `listMemories` declares, confining every `/memories/{memory_id}`
 * route. `actor_id` also narrows a store's export and assertion ledger.
 */
export const memoryPins = resourcePins({ listOperation: 'listMemories' });
