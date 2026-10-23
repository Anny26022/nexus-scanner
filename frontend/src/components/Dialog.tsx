import * as RadixDialog from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';

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
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay onPointerDown={event => { event.stopPropagation(); onClose(); }} className="dialog-backdrop fixed inset-0 z-(--z-dialog) bg-[rgb(15_23_31_/_48%)] backdrop-blur-xs animate-in fade-in duration-150" />
        <div className="fixed inset-0 z-[calc(var(--z-dialog)+1)] grid place-items-center pointer-events-none">
          <RadixDialog.Content
            ref={contentRef}
            aria-label={label}
            className={`dialog pointer-events-auto outline-none animate-in fade-in zoom-in-95 duration-150 ${className}`}
            onOpenAutoFocus={event => {
              // Keep focus on the dialog itself so no control shows a focus ring on open; autofocused fields keep focus.
              event.preventDefault();
              if (!contentRef.current?.contains(document.activeElement)) contentRef.current?.focus();
            }}
            onEscapeKeyDown={event => {
              if (contentRef.current?.querySelector('[data-escape-layer]')) event.preventDefault();
            }}
          >
            <div className="dialog-surface">{children}</div>
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
