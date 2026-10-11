import { useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Native modal supplies focus trapping, background inertness and Escape. */
export function Dialog({ label, onClose, children, className = '' }: {
  label: string; onClose: () => void; children: ReactNode; className?: string;
}) {
  const mount = useCallback((node: HTMLDialogElement | null) => {
    if (!node) return;
    node.showModal();
    return () => node.close();
  }, []);
  return createPortal(<dialog ref={mount} aria-label={label} className={`dialog ${className}`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-surface">{children}</div>
  </dialog>, document.body);
}
