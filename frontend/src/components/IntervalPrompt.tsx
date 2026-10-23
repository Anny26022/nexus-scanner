import { useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import type { Interval } from '../chart/model';

/** "1D", "D", "1W", "w", "1M"… → an interval; anything else is null. */
export function parseInterval(text: string): Interval | null {
  const match = text.trim().toUpperCase().match(/^(1)?\s*(D|W|M)$/);
  return match ? match[2] as Interval : null;
}

/**
 * TradingView's interval box: typing a digit on the chart opens it with that digit,
 * Enter applies "1D"/"1W"/"1M" (or D/W/M). Text that isn't an interval goes to symbol search instead.
 */
export function IntervalPrompt({initial, onInterval, onSymbol, onClose}: {
  initial: string; onInterval: (interval: Interval) => void; onSymbol: (text: string) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const interval = parseInterval(draft);
  return <RadixDialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <RadixDialog.Portal>
      <RadixDialog.Content className="interval-prompt" aria-label="Change interval"
        onOpenAutoFocus={event => { event.preventDefault(); (event.currentTarget as HTMLElement).querySelector('input')?.focus(); }}>
        <RadixDialog.Title className="interval-prompt-title">Change interval</RadixDialog.Title>
        <form onSubmit={event => {
          event.preventDefault();
          if (interval) onInterval(interval);
          else if (draft.trim()) onSymbol(draft.trim().toUpperCase());
          onClose();
        }}>
          <input aria-label="Interval" value={draft} autoComplete="off" spellCheck={false} maxLength={12}
            onChange={event => setDraft(event.target.value.toUpperCase())} />
        </form>
        <p className="interval-prompt-hint">{interval ? `Enter to switch to ${interval === 'D' ? '1 day' : interval === 'W' ? '1 week' : '1 month'}` : draft.trim() ? 'Not an interval — Enter searches symbols' : 'Type 1D, 1W or 1M'}</p>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}
