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
- [ ] Spec: the `tags` query parameter on the list operation, the three tag
      paths (`get<X>Tags`, `replace<X>Tags`, `merge<X>Tags`), inline
      `additionalProperties: { type: string }` — no cross-file `$ref` (#1280)
- [ ] Permissions: the three operationIds in `src/permissions/<module>.json`
- [ ] Docs: a `### Tags` entry under Key Concepts naming the `?tags=` filter;
      `iam.md` §Tags lists the resource
- [ ] Tests: `tests/unit/tests/rest/<module>Tags.test.ts` — happy path, `401`,
      `403`, `404`, `400` on a non-string value and on an array body, list
      filter narrows, pair without a colon is `400`

## Rules

- Tag bags are opaque values (`case-convention.md`): never read, rename or
  case-convert a key.
- One matching rule: `?tags=`, knowledge search and `soat:ResourceTag/<key>`
  all read the column by JSONB containment (`tagContainment`).
- Never `ctx.request.body as Record<string, string>`: `String(["a","b"])` is
  `"a,b"` and a policy condition would match a tag nobody wrote.
- Authorization stays in the module. `registerTagRoutes` owns the contract
  (body shape, response is the bag), not who may read or write.
