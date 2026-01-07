# OpenAPI Specifications

This directory contains OpenAPI specifications for the SOAT REST API.

## Structure

```
openapi/
├── v1/
│   └── files.yaml    # Files API v1 specification
└── README.md         # This file
```

## Versioning

Each API version has its own directory (e.g., `v1/`, `v2/`). Each resource should have its own spec file for better organization and maintainability.

## Workflow

### 1. Update Spec When Modifying API

When you add, modify, or remove endpoints in the REST API code, **always update the corresponding OpenAPI spec**:

1. Edit the relevant YAML file in the version directory (e.g., `v1/files.yaml`)
2. Update paths, schemas, request/response bodies, etc.
3. Test the spec locally (see below)

### 2. Generate Documentation

From the `packages/website` directory:

```bash
cd packages/website
pnpm run gen-api-docs
```

This will:

- Parse the OpenAPI specs
- Generate MDX files in `packages/website/docs/api/`
- Create sidebars for the API documentation

### 3. Preview Documentation

Start the development server:

```bash
cd packages/website
pnpm run dev
```

Then open http://localhost:3000/docs/api/files/soat-files-api to see the generated API docs.

### 4. Clean Generated Docs

If you need to regenerate from scratch:

```bash
cd packages/website
pnpm run docusaurus clean-api-docs all
pnpm run gen-api-docs
```

## Best Practices

### Spec Quality

- **Keep specs in sync with code**: Update specs in the same PR as code changes
- **Use descriptive examples**: Add realistic `example` values to schemas
- **Document errors**: Include all possible error responses (400, 404, 500, etc.)
- **Add operation IDs**: Use meaningful `operationId` for each endpoint
- **Tag properly**: Use tags to group related endpoints in the sidebar

### Validation

Before committing, validate your spec:

```bash
pnpm run lint-openapi
```

Or use an online validator like [Swagger Editor](https://editor.swagger.io/).

### Documentation

- **Add descriptions**: Every path, parameter, schema should have a description
- **Use vendor extensions**: Add `x-codeSamples` for code examples (see [docusaurus-openapi docs](https://docusaurus-openapi.tryingpan.dev/vendor-extensions))
- **Server URLs**: Update `servers` array with correct environment URLs

## Example Structure

```yaml
openapi: 3.0.3
info:
  title: Resource API
  version: 1.0.0
  description: Description of the API
servers:
  - url: http://0.0.0.0:5047/api/v1
    description: Development server
paths:
  /resource:
    get:
      tags:
        - Resource
      summary: Brief summary
      description: Detailed description
      operationId: operationName
      responses:
        '200':
          description: Success response
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ResourceResponse'
components:
  schemas:
    ResourceResponse:
      type: object
      properties:
        id:
          type: string
          example: 'abc123'
```

## CI/CD Integration

The API documentation generation should be integrated into the CI/CD pipeline:

1. **Validation**: Run spec validation in CI to catch errors early
2. **Generation**: Auto-generate docs before building the website
3. **Deployment**: Deploy updated docs with every release

Example GitHub Actions workflow snippet:

```yaml
- name: Validate OpenAPI specs
  run: npx @stoplight/spectral-cli lint packages/server/src/rest/openapi/**/*.yaml

- name: Generate API docs
  run: |
    cd packages/website
    pnpm run gen-api-docs
```

## Resources

- [OpenAPI 3.0 Specification](https://swagger.io/specification/)
- [Docusaurus OpenAPI Plugin](https://docusaurus-openapi.tryingpan.dev/)
- [Spectral Linter](https://stoplight.io/open-source/spectral)
- [Swagger Editor](https://editor.swagger.io/)
