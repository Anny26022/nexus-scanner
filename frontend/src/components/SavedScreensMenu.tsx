import { useState, type FormEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Bookmark, Check, Link2, Trash2 } from 'lucide-react';
import { useLocalStorageState } from '../hooks/useLocalStorageState';
import {
  SAVED_SCREENS_KEY, normalizeScreenName, parseSavedScreens, screenShareUrl, upsertSavedScreen,
  type SavedScreen, type ScreenDefinition,
} from '../utils/savedScreens';
import { Button } from './Button';

const UNIVERSE_LABELS: Record<string, string> = {mainboard: 'Mainboard', nifty50: 'Nifty 50', nifty500: 'Nifty 500', midsmall400: 'MidSmall 400'};

export function describeScreen(screen: ScreenDefinition) {
  const filters = Object.keys(screen.conditions).length;
  const criteria = screen.query ? 'Query' : `${filters} ${filters === 1 ? 'filter' : 'filters'}`;
  return `${criteria} · ${UNIVERSE_LABELS[screen.universe] ?? screen.universe}`;
}

/** Saved screens and share links for the Screener toolbar. */
export function SavedScreensMenu({current, onLoad}: {current: ScreenDefinition; onLoad: (screen: ScreenDefinition) => void}) {
  const [stored, setStored] = useLocalStorageState<unknown>(SAVED_SCREENS_KEY, []);
  const screens = parseSavedScreens(stored);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState('');

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(value => value === message ? '' : value), 2200);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const clean = normalizeScreenName(name);
    if (!clean) return;
    const replacing = screens.some(item => item.name.toLowerCase() === clean.toLowerCase());
    setStored(upsertSavedScreen(screens, clean, current));
    setName('');
    flash(replacing ? `Updated “${clean}”` : `Saved “${clean}”`);
  };
  const load = (item: SavedScreen) => {
    onLoad(item.screen);
    setOpen(false);
  };
  const remove = (item: SavedScreen) => setStored(screens.filter(entry => entry.id !== item.id));
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(screenShareUrl(current));
      flash('Link copied');
    } catch {
      flash('Copy failed. Your browser blocked clipboard access.');
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (!next) setNotice(''); }}>
      <Popover.Trigger asChild>
        <Button variant="ghost" className="toolbar-icon-button" aria-label="Saved screens" title="Saved screens: save, load and share">
          <Bookmark size={14} aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={12}
          className="z-(--z-menu) w-[320px] rounded-(--radius-lg) bg-surface p-2 text-[13px] text-text shadow-(--shadow-pop) outline-none animate-in fade-in zoom-in-95 duration-150">
          <form onSubmit={save} className="flex gap-1.5 p-1">
            <input
              aria-label="Screen name"
              value={name}
              maxLength={60}
              onChange={event => setName(event.target.value)}
              placeholder="Name this screen"
              className="h-8 min-w-0 flex-1 rounded-(--radius-md) bg-field px-2.5 text-[13px] text-text outline-none placeholder:text-muted focus:bg-surface focus:shadow-(--ring)"
            />
            <Button type="submit" variant="primary" disabled={!normalizeScreenName(name)}>Save</Button>
          </form>
          <p className="px-1.5 pb-1 pt-0.5 text-[11.5px] text-muted">Saving with an existing name updates that screen.</p>
          <div className="my-1 h-px bg-line" />
          {screens.length === 0
            ? <p className="px-2.5 py-4 text-center text-[12.5px] text-muted">No saved screens yet. Name the current screen above to keep it.</p>
            : <ul className="max-h-[280px] overflow-y-auto py-0.5" aria-label="Saved screens list">
              {screens.map(item => (
                <li key={item.id} className="group flex items-center gap-1 rounded-(--radius-md) pr-1 hover:bg-surface-hover">
                  <button type="button" onClick={() => load(item)} title={`Load ${item.name}`}
                    className="flex min-w-0 flex-1 flex-col items-start px-2.5 py-1.5 text-left">
                    <span className="w-full truncate font-medium text-text">{item.name}</span>
                    <span className="w-full truncate text-[11.5px] text-muted">{describeScreen(item.screen)}</span>
                  </button>
                  <button type="button" onClick={() => remove(item)} aria-label={`Delete ${item.name}`} title="Delete"
                    className="grid size-7 shrink-0 place-items-center rounded-(--radius-sm) text-muted opacity-0 transition-opacity hover:bg-negative-soft hover:text-negative focus-visible:opacity-100 group-hover:opacity-100">
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>}
          <div className="my-1 h-px bg-line" />
          <div className="flex items-center justify-between gap-2 p-1">
            <Button variant="ghost" onClick={() => void copyLink()}><Link2 size={13} aria-hidden="true" />Copy link to this screen</Button>
            {notice && <span role="status" className="inline-flex items-center gap-1 truncate text-[12px] font-medium text-accent"><Check size={12} aria-hidden="true" />{notice}</span>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
