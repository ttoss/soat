Color-coded HTTP method tag used across the SOAT API reference; fixed minimum width keeps endpoint rows aligned.

```jsx
<MethodBadge method="GET" /> /api/v1/projects
<MethodBadge method="POST" /> /api/v1/agents
<MethodBadge method="DELETE" /> /api/v1/secrets/{id}
```

Methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` (renders as DEL), `HEAD`. Colors come from the `--method-*` tokens.
