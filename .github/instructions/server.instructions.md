---
applyTo: '**/packages/server/**'
description: Instructions for the server package architecture, development, and building.
---

# Server Instructions

Follow the packages documentation:

- `@ttoss/http-server`: #fetch https://ttoss.dev/docs/modules/packages/http-server/
- `@ttoss/http-server-mcp`: #fetch https://ttoss.dev/docs/modules/packages/http-server-mcp/

## Architecture

The server src will have three folders: rest, mcp, and lib.

### Business Logic Layer

All business logic (database queries, data transformations) must live in `src/lib/`, organized by resource:

- `src/lib/files.ts` - All file-related business logic (listFiles, getFile, createFile, deleteFile)
- Additional resources follow the same pattern: `src/lib/<resource>.ts`

Route handlers **must not** contain direct database calls. They are responsible only for HTTP concerns: parsing request bodies/params, calling lib functions, and setting response status/body.

Lib functions **must always return plain mapped objects**, never raw model instances. This is required to avoid exposing sensitive or internal data (e.g., internal DB fields, hashed passwords, audit columns) through the API. Every function that queries the database must map the result to a plain object before returning it:

### Public ID as `id`

The internal database `id` (primary key) **must never be returned to the user**. Always expose `publicId` as `id` in API responses:

```ts
export const getFile = async (args: { id: string }) => {
  const file = await db.File.findOne({ where: { publicId: args.id } });
  if (!file) return null;
  return {
    id: file.publicId, // publicId is exposed as `id`
    filename: file.filename,
    // ... all fields explicitly mapped, internal `id` is never included
  };
};
```

- Route parameters and query inputs that reference a resource by ID will always be `publicId` values.
- The database `id` column is for internal joins only and must not appear in any API response, OpenAPI schema, or MCP tool output.

### REST API Structure

The REST API is organized by version and resource for better maintainability and versioning:

- `src/rest/v1/files.ts` - Contains all file-related endpoints and handlers for API version 1
- Future versions will follow the same pattern: `src/rest/v2/files.ts`, etc.

Each version folder contains resource-specific files. Additional resources can be added as separate files (e.g., `users.ts`, `analytics.ts`) within each version folder.

#### Router Organization

API routes are not defined directly in `src/index.ts` to maintain clean separation of concerns:

- `src/rest/router.ts` - Central REST API router that imports and mounts versioned routers
- Version-specific routers (e.g., `src/rest/v1/files.ts`) define the actual route handlers
- `src/index.ts` remains focused on application setup, middleware, and mounting the main routers

This structure ensures scalability and keeps the main entry point uncluttered as the API grows.

#### Swagger JSDoc

Every route handler **must** have an `@openapi` JSDoc block immediately before it. The JSDoc must match the handler's actual behavior (paths, status codes, request/response shapes).

```ts
/**
 * @openapi
 * /files:
 *   get:
 *     tags:
 *       - Files
 *     summary: List all files
 *     operationId: listFiles
 *     responses:
 *       '200':
 *         description: ...
 */
filesRouter.get('/files', async (ctx: Context) => { ... });
```

#### OpenAPI Documentation

When modifying or adding REST API endpoints, **always update both**:

1. The `@openapi` JSDoc block on the route handler
2. The corresponding OpenAPI specification in `src/rest/openapi/v1/<resource>.yaml`

Follow the guidelines in `src/rest/openapi/README.md`. This includes:

- Updating paths, schemas, request/response bodies, and error responses
- Adding descriptive examples and operation IDs
- Validating the spec before committing changes
- Ensuring the spec remains in sync with the implementation

### MCP Structure

The MCP (Model Context Protocol) folder is organized to separate concerns and maintain scalability:

- `src/mcp/index.ts` - Main entry point that exports the MCP router
- `src/mcp/server.ts` - MCP server initialization and configuration
- `src/mcp/tools/` - Directory containing tool definitions and handlers
  - `src/mcp/tools/index.ts` - Exports all tools
  - `src/mcp/tools/memory.ts` - Memory-related tools (record, recall)
  - Additional tool files as needed (e.g., `documents.ts`, `files.ts`)
- `src/mcp/resources/` - Directory for resource definitions (if any)
- `src/mcp/prompts/` - Directory for prompt templates (if any)

This structure allows for easy addition of new tools and resources while keeping the code organized and maintainable.

## Development

To run the server in development mode with watch, navigate to the server package and run:

```bash
cd packages/server
pnpm dev
```

Alternatively, from the root directory:

```bash
pnpm --filter @soat/server dev
```

This will start the server with `tsx watch src/server.ts`, which watches for file changes and restarts automatically.

## Building

To build the server for production:

```bash
cd packages/server
pnpm build
```

This uses `tsup` to compile the TypeScript code.

## Manual Testing

### REST API Endpoints

To test REST API endpoints during development:

1. **Start the development server:**

   ```bash
   cd packages/server
   pnpm dev
   ```

2. **Make requests using curl to `0.0.0.0:5047`:**

   **Important:** Always use `0.0.0.0` instead of `localhost` when making curl requests to avoid connection issues.

   Example endpoints:

   ```bash
   # List files
   curl -X GET http://0.0.0.0:5047/api/v1/files

   # Upload a file
   curl -X POST http://0.0.0.0:5047/api/v1/files/upload \
     -H "Content-Type: application/json" \
     -d '{"content":"Hello World!","options":{"contentType":"text/plain","metadata":{"filename":"test.txt"}}}'

   # Get file by ID
   curl -X GET http://0.0.0.0:5047/api/v1/files/{file-id}

   # Delete file
   curl -X DELETE http://0.0.0.0:5047/api/v1/files/{file-id}
   ```

## Unit Testing

Unit tests are located in the #file:../../packages/server/tests/unit/ folder. To run the unit tests for the server package, use the following command from the root directory:

```bash
pnpm --filter @soat/server test
```

To run tests for a specific file, use the `--testPathPatterns` flag:

```bash
pnpm --filter @soat/server test --testPathPatterns=users.test.ts
```
