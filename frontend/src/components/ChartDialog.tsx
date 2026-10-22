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
        <RadixDialog.Overlay onPointerDown={event => { event.stopPropagation(); onClose(); }} className="chart-modal-backdrop animate-in fade-in duration-150" />
        <div className="fixed inset-0 z-[calc(var(--z-dialog)+1)] grid place-items-center p-[10px] sm:p-[18px] pointer-events-none">
          <RadixDialog.Content
            aria-label={title}
            className={`chart-modal pointer-events-auto outline-none animate-in fade-in zoom-in-95 duration-150 ${className}`}
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
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
