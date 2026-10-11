import { useCallback, useEffect, useRef, useState } from 'react';
import { companyPopoverPosition } from '../utils/companyPopoverPosition';

export function useSymbolHoverCard<T extends {symbol: string}>() {
  const [active, setActive] = useState<(ReturnType<typeof companyPopoverPosition> & {row: T; pinned: boolean}) | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyboardEntry = useRef(false);
  const cancelClose = useCallback(() => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => { cancelClose(); setActive(null); }, [cancelClose]);
  const close = useCallback(() => { trigger.current?.focus(); dismiss(); }, [dismiss]);
  const id = active ? `company-overview-${active.row.symbol}` : undefined;
  const open = (row: T, button: HTMLButtonElement, pinned = false) => {
    cancelClose();
    trigger.current = button;
    setActive(current => ({row, ...companyPopoverPosition(button),
      pinned: pinned || Boolean(current?.row.symbol === row.symbol && current.pinned)}));
  };
  const enter = (row: T, button: HTMLButtonElement) => {
    keyboardEntry.current = true;
    open(row, button);
    const panel = document.getElementById(`company-overview-${row.symbol}`);
    if (panel) {
      keyboardEntry.current = false;
      panel.querySelector<HTMLElement>('button')?.focus();
    }
  };
  const scheduleClose = () => {
    cancelClose();
    timer.current = setTimeout(() => setActive(current => current?.pinned ||
      (current && document.getElementById(`company-overview-${current.row.symbol}`)?.contains(document.activeElement))
      ? current : null), 180);
  };

  // External listeners belong to the reusable hook and are removed on dismissal.
  useEffect(() => {
    if (!id) return;
    if (keyboardEntry.current) {
      keyboardEntry.current = false;
      document.getElementById(id)?.querySelector<HTMLElement>('button')?.focus();
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!document.getElementById(id)?.contains(target) && !trigger.current?.contains(target)) dismiss();
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !document.getElementById(id)?.contains(event.target)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', dismiss);
    return () => {
      cancelClose();
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', dismiss);
    };
  }, [id, cancelClose, close, dismiss]);
  return {active, id, open, enter, close, dismiss, scheduleClose, cancelClose};
}
