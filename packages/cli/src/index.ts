import { log } from '@ttoss/logger';
import { program } from 'commander';

import pkg from '../package.json' with { type: 'json' };

program
  .name('soat')
  .description('SOAT CLI - Command Line Interface for SOAT')
  .version(pkg.version);

program.action(() => {
  log.info(`SOAT CLI version ${pkg.version}. Work is in progress...`);
});

program.parse();
