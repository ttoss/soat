---
paths:
  - "packages/server/**"
  - "packages/postgresdb/**"
---

# Tagged Resources

A resource with a `tags` column gets four capabilities from one mechanism; a
resource that hand-rolls any of them is a bug. Everything shared lives in
`packages/server/src/lib/tags.ts` and `src/rest/v1/tagRoutes.ts`.

## Checklist

- [ ] Model: `@Column({ type: DataType.JSONB, allowNull: true }) declare tags:
      Record<string, string> | null;`
- [ ] IAM: `registerResourceFieldMap({ resourceType, publicIdColumn,
      tagsColumn: { column: 'tags' } })` in the lib, and
      `context: buildResourceTagContext({ resourceType, tags })` on every
      `isAllowed` call for the resource
- [ ] Sub-resource: `registerTagRoutes({ router, path, resolve, readTags,
      writeTags })` in the REST module; `resolve` loads the resource and throws
      `RESOURCE_NOT_FOUND` / `FORBIDDEN` for the given `access`
- [ ] List filter: `const tags = readTagQuery(ctx.query.tags)` in the route,
      `applyTagFilter({ where, tags })` in the lib list function
- [ ] Writes: `readTagBag(body.tags)` (or `readNullableTagBag` when `null`
      clears) on every create/update body that carries `tags`
- [ ] Spec: the `tags` query parameter on the list operation and the three tag
      paths (`get<X>Tags`, `replace<X>Tags`, `merge<X>Tags`), every one of them
      a `$ref` into `openapi/v1/tags.yaml` — `TagBag`, `NullableTagBag` where
      `null` clears the bag, `TagsQuery` for the parameter. Never re-inline
      `additionalProperties: { type: string }` (`tagSchemaContract.test.ts`)
- [ ] Permissions: the three operationIds in `src/permissions/<module>.json`
- [ ] Docs: a `### Tags` entry under Key Concepts naming the `?tags=` filter;
      `iam.md` §Tags lists the resource
- [ ] Tests: `tests/unit/tests/rest/<module>Tags.test.ts` — happy path, `401`,
      `403`, `404`, `400` on a non-string value and on an array body, list
      filter narrows, pair without a colon is `400`

## Rules

- The shape is declared once, in `openapi/v1/tags.yaml`. A site that needs its
  own wording keeps it beside a single-member `allOf`, never as a sibling of
  `$ref` — OpenAPI 3.0 ignores those:

  ```yaml
  tags:
    description: Replaces the stored bag; `null` clears it.
    allOf:
      - $ref: './tags.yaml#/components/schemas/NullableTagBag'
  ```

  The server, the SDK generator and the docs pages all resolve those refs.
  `@ttoss/openapi-codegen` does not, so `packages/cli/scripts/localizeSpecs.ts`
  inlines the shared components on the way into the CLI manifest; a new shared
  component is picked up automatically as long as its file declares no paths.
- Tag bags are opaque values (`case-convention.md`): never read, rename or
  case-convert a key.
- One matching rule: `?tags=`, knowledge search and `soat:ResourceTag/<key>`
  all read the column by JSONB containment (`tagContainment`).
- Never `ctx.request.body as Record<string, string>`: `String(["a","b"])` is
  `"a,b"` and a policy condition would match a tag nobody wrote.
- Authorization stays in the module. `registerTagRoutes` owns the contract
  (body shape, response is the bag), not who may read or write.
