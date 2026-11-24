import fs from 'node:fs';
import path from 'node:path';

import {
  declareInSpec,
  routeErrorCodes,
  specDir,
  specFiles,
} from '../tests/harness/routeErrorCodes.mjs';

/** Writes each operation's `x-raises` from the codes its route reaches. */
const reached = routeErrorCodes();
const codesOf = (key) => {
  return reached.get(key);
};
for (const file of specFiles()) {
  const at = path.join(specDir, file);
  const text = fs.readFileSync(at, 'utf8');
  const written = declareInSpec({ text, codesOf });
  if (written !== text) fs.writeFileSync(at, written);
}
