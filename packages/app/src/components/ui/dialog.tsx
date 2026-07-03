import type * as React from 'react';

import { Button } from '@/components/ui/button';

type DialogProps = {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
};

// Shared full-screen overlay dialog: backdrop click and the close button both
// dismiss. Extracted from the action-run modal so every confirm/edit overlay
// in the generic engine shares one implementation.
export const Dialog = ({
  title,
  subtitle,
  onClose,
  children,
}: DialogProps): React.ReactElement => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col gap-6 overflow-y-auto rounded-lg border bg-background/80 p-6 shadow-glow-violet-md backdrop-blur-lg"
      >
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold">{title}</h2>
            {subtitle}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
          >
            {'✕'}
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
};
