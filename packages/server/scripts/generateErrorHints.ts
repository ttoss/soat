import * as fs from 'node:fs';

import {
  buildErrorHintsExport,
  ERROR_HINTS_EXPORT_PATH,
} from '../src/errors/hintExport';

fs.writeFileSync(
  ERROR_HINTS_EXPORT_PATH,
  `${JSON.stringify(buildErrorHintsExport(), null, 2)}\n`
);
