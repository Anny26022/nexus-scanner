import { useState } from 'react';
import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { addSymbolsToWatchlist } from '../chart/storage';
import { Button } from './Button';

/** Adds every matched symbol (not just the visible page) to the Charts watchlist. */
export function AddToWatchlist({loadSymbols, heading, disabled = false}: {
  loadSymbols: () => Promise<string[]>;
  heading?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const add = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const result = addSymbolsToWatchlist(await loadSymbols(), heading);
      setMessage(!result ? 'Watchlist could not be saved'
        : result.added ? `Added ${result.added} to watchlist`
          : 'Already in your watchlist');
    } catch {
      setMessage('Results changed. Run the scan again.');
    } finally {
      setBusy(false);
      window.setTimeout(() => setMessage(''), 2500);
    }
  };

  return <>
    <Button
      variant="secondary"
      className="results-copy-button"
      aria-label={message || (busy ? 'Adding to watchlist' : 'Add all results to watchlist')}
      title={message || 'Add all results to watchlist'}
      disabled={disabled || busy}
      onClick={() => void add()}
    >
      {message.startsWith('Added') ? <BookmarkCheck size={15} className="text-accent" /> : <BookmarkPlus size={15} />}
    </Button>
    {message && <span role="status" className="sr-only">{message}</span>}
  </>;
}
