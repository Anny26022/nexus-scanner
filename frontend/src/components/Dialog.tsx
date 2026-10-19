import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

/** Accessible modal powered by Radix UI: focus trapping, background inertness, Escape, and portal rendering. */
export function Dialog({
  label,
  onClose,
  children,
  className = '',
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop fixed inset-0 z-50 bg-[rgb(15_23_31_/_48%)] backdrop-blur-xs animate-in fade-in duration-150" />
        <RadixDialog.Content
          aria-label={label}
          className={`dialog fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none animate-in fade-in zoom-in-95 duration-150 ${className}`}
        >
          <div className="dialog-surface">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
