---
applyTo: '**/packages/server/**'
description: Instructions for the server package architecture, development, and building.
---

# Server Instructions

Follow the packages documentation:

- `@ttoss/http-server`: #fetch https://ttoss.dev/docs/modules/packages/http-server/
- `@ttoss/http-server-mcp`: #fetch https://ttoss.dev/docs/modules/packages/http-server-mcp/

## Architecture

The server src will have two folders: rest and mcp.

### REST API Structure

The REST API is organized by version and resource for better maintainability and versioning:

- `src/rest/v1/documents.ts` - Contains all document-related endpoints and handlers for API version 1
- Future versions will follow the same pattern: `src/rest/v2/documents.ts`, etc.

Each version folder contains resource-specific files. Currently, only the documents resource is implemented, but additional resources can be added as separate files (e.g., `users.ts`, `analytics.ts`) within each version folder.

#### Router Organization

API routes are not defined directly in `src/index.ts` to maintain clean separation of concerns:

- `src/rest/router.ts` - Central REST API router that imports and mounts versioned routers
- Version-specific routers (e.g., `src/rest/v1/documents.ts`) define the actual route handlers
- `src/index.ts` remains focused on application setup, middleware, and mounting the main routers

This structure ensures scalability and keeps the main entry point uncluttered as the API grows.

#### OpenAPI Documentation

When modifying or adding REST API endpoints, **always update the corresponding OpenAPI specification** in `src/rest/openapi/` and follow the guidelines outlined in `src/rest/openapi/README.md`. This includes:

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

### Core Functionality Guidelines

**Important**: Core business logic and functionalities must be implemented in dedicated core packages (e.g., `@soat/documents-core`, `@soat/text-atomizer`) and never directly in the server folder.

The server package should only contain:

- HTTP routing and request handling
- Middleware configuration
- Integration with core packages
- API versioning and structure

This separation ensures:

- Reusability of core logic across different interfaces (CLI, web, etc.)
- Better testability of business logic
- Cleaner architecture with clear boundaries

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

### REST API Tests

REST API tests are located in the #file:../../packages/server/tests/unit/tests/rest/ folder. These tests cover the various endpoints and functionalities of the REST API.

- Each endpoint has corresponding test files that validate the expected behavior.
- Use mocks on #file:../../packages/server/tests/unit/setupTests.ts to mock external dependencies only and isolate the tests.
- Test the whole app, #file:../../packages/server/src/app.ts , to ensure all middleware and routes are properly integrated. Use supertest to simulate HTTP requests and validate responses.
  In the example below, `saveFile` from `@soat/files-core` is mocked to test the file upload endpoint without actually saving a file.

  ```ts
  import { saveFile } from '@soat/files-core';
  import { app } from 'src/app';
  import request from 'supertest';

  test('should create a file via REST API', async () => {
    const savedFile = {
      id: 'test-id',
      filename: 'test.txt',
      content: 'Hello, World!',
      metadata: {},
    };

    jest.mocked(saveFile).mockResolvedValue(savedFile);

    const response = await request(app.callback())
      .post('/api/v1/files/upload')
      .send({
        content: 'Hello, World!',
        options: { metadata: { filename: 'test.txt' } },
      })
      .set('Accept', 'application/json');

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: 'test-id',
      filename: 'test.txt',
      success: true,
    });
    expect(saveFile).toHaveBeenCalledWith({
      config: { local: { path: '/tmp/files' }, type: 'local' },
      content: 'Hello, World!',
      options: { metadata: { filename: 'test.txt' } },
    });
  });
  ```
