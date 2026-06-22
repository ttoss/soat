import { CheckCircle, Copy, KeyRound } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';

import type { RevealedSecret } from './formHelpers';
import { humanizeKey } from './specUtils';

const SecretRow = ({ secret }: { secret: RevealedSecret }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(secret.value).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    });
  };

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        {humanizeKey(secret.key)}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-auto rounded bg-black/10 px-2 py-1 font-mono text-xs dark:bg-white/10">
          {secret.value}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          className="shrink-0"
        >
          {copied ? (
            <CheckCircle className="mr-1.5 h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="mr-1.5 h-3.5 w-3.5" />
          )}
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
    </div>
  );
};

type SecretRevealProps = {
  title: string;
  secrets: RevealedSecret[];
  onDone: () => void;
};

export const SecretReveal = ({
  title,
  secrets,
  onDone,
}: SecretRevealProps): React.ReactElement => {
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-orange-500" />
        <h2 className="text-xl font-semibold">{title}</h2>
      </div>
      <div className="space-y-3 rounded-lg border border-orange-500/30 bg-orange-500/10 px-4 py-3">
        <p className="text-sm font-medium text-orange-700 dark:text-orange-400">
          {'Copy these values now — they will not be shown again.'}
        </p>
        {secrets.map((secret) => {
          return <SecretRow key={secret.key} secret={secret} />;
        })}
      </div>
      <div>
        <Button onClick={onDone}>{'Done'}</Button>
      </div>
    </div>
  );
};
