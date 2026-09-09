---
paths:
  - "packages/server/src/**"
---

# Debug Logging

Use the `debug` package, never `console.*`, in lib and route code. One
namespace per module file, `soat:<module>` (`soat:actors`, `soat:generation`):

```ts
import createDebug from 'debug';

const log = createDebug('soat:<module>');
```

Log at the entry of every exported lib function and at significant branches
(auto-created linked resources, `findOrCreate` results, early returns, resolved
ids). printf style, prefixed with the function name: `%s` strings/ids, `%d`
numbers, `%o` objects, `%O` multiline objects.

```ts
log('createActor: projectId=%d name=%s', args.projectId, args.name);
```

Enable: `DEBUG=soat:actors`, `DEBUG=soat:*`, or `DEBUG=*`.

Never log secrets (passwords, tokens, keys). Never log inside tests; add lib
logging instead.
