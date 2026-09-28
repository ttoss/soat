import Link from '@docusaurus/Link';
import { PRIMARY_ACTION } from '@site/src/data/homepage';
import clsx from 'clsx';
import type * as React from 'react';

/**
 * The homepage's one conversion action. Every band that asks the reader to act
 * renders this, so the label and destination cannot diverge between bands.
 */
const PrimaryAction = (props: { className?: string }): React.ReactNode => {
  return (
    <Link
      className={clsx('button button--primary button--lg', props.className)}
      to={PRIMARY_ACTION.to}
    >
      {PRIMARY_ACTION.label}
    </Link>
  );
};

export default PrimaryAction;
