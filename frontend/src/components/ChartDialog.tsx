import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/** A chart modal powered by Radix UI: accessible focus containment, Escape, backdrop dismissal, and focus return. */
export function ChartDialog({
  title,
  onClose,
  children,
  className = '',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="chart-modal-backdrop fixed inset-0 z-50 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150" />
        <RadixDialog.Content
          aria-label={title}
          className={`chart-modal fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none animate-in fade-in zoom-in-95 duration-150 ${className}`}
        >
          <header className="chart-modal-heading">
            <h2>{title}</h2>
            <RadixDialog.Close asChild>
              <button
                type="button"
                className="chart-icon-button"
                aria-label={`Close ${title.toLowerCase()}`}
              >
                <X size={18} />
              </button>
            </RadixDialog.Close>
          </header>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
