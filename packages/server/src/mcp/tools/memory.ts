// Memory-related MCP tools
// import { recallMemory } from './recallMemory';
// import { recordMemory } from './recordMemory';

// export const recordMemoryTool = {
//   name: 'record-memory',
//   description: 'Records a memory entry for an agent.',
//   inputSchema: {
//     content: z.string().min(1).describe('The content to store in memory'),
//   },
//   handler: async (args) => {
//     const response = await recordMemory({ content: args.content });
//     return {
//       content: [
//         {
//           type: 'text',
//           text: response.message,
//         },
//       ],
//     };
//   },
// };

// export const recallMemoryTool = {
//   name: 'recall-memory',
//   description: 'Recalls memories similar to the given query using semantic search.',
//   inputSchema: {
//     query: z.string().min(1).describe('The query to search for in memories'),
//     limit: z
//       .number()
//       .min(1)
//       .max(100)
//       .optional()
//       .describe('Maximum number of memories to return (default: 10)'),
//   },
//   handler: async (args) => {
//     const response = await recallMemory({
//       query: args.query,
//       limit: args.limit,
//     });

//     if (response.memories.length === 0) {
//       return {
//         content: [
//           {
//             type: 'text',
//             text: 'No memories found matching your query.',
//           },
//         ],
//       };
//     }

//     const memoriesText = response.memories
//       .map((memory, index) => {
//         return `${index + 1}. ${memory.content} (distance: ${memory.distance.toFixed(4)})`;
//       })
//       .join('\n');

//     return {
//       content: [
//         {
//           type: 'text',
//           text: `Found ${response.memories.length} memories:\n\n${memoriesText}`,
//         },
//       ],
//     };
//   },
// };
