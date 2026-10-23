import { useState, type FormEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Eraser, FolderPlus, Heading, Pencil, Trash2 } from 'lucide-react';
import { FLAG_COLORS, flaggedSymbols, type FlagColor, type WatchlistFlags, type WatchlistStore } from '../chart/watchlists';

type Editing = null | 'new' | 'rename' | 'section';

/** Header switcher for named watchlists and colour-flag lists, with list actions. */
export function WatchlistMenu({store, flags, view, title, count, onSwitch, onView, onCreate, onRename, onAddSection, onClear, onDelete}: {
  store: WatchlistStore;
  flags: WatchlistFlags;
  view: FlagColor | null;
  title: string;
  count: number;
  onSwitch: (id: string) => void;
  onView: (flag: FlagColor | null) => void;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
  onAddSection: (name: string) => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState('');
  const close = () => { setOpen(false); setEditing(null); setDraft(''); };
  const startEditing = (mode: Editing, initial = '') => { setEditing(mode); setDraft(initial); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    if (editing === 'new') onCreate(draft);
    else if (editing === 'rename') onRename(draft);
    else if (editing === 'section') onAddSection(draft);
    close();
  };
  const activeName = store.lists.find(list => list.id === store.activeId)?.name ?? 'Watchlist';
  const flagColor = view ? FLAG_COLORS.find(flag => flag.id === view)?.color : undefined;

  return <Popover.Root open={open} onOpenChange={next => next ? setOpen(true) : close()}>
    <Popover.Trigger asChild>
      <button type="button" className="watchlist-switcher" aria-label="Watchlist options" title="Watchlist options">
        {flagColor && <span className="watchlist-flag-dot" style={{background: flagColor}} aria-hidden="true" />}
        <span className="watchlist-switcher-name">{title}</span>
        <span className="watchlist-badge">{count}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content align="start" sideOffset={6} collisionPadding={12} className="watchlist-menu" aria-label="Watchlists">
        {editing ? <form className="watchlist-menu-form" onSubmit={submit}>
          <label className="watchlist-menu-label" htmlFor="watchlist-menu-input">
            {editing === 'new' ? 'New watchlist' : editing === 'rename' ? 'Rename watchlist' : 'New section'}
          </label>
          <input id="watchlist-menu-input" autoFocus value={draft} maxLength={40} onChange={event => setDraft(event.target.value)}
            placeholder={editing === 'section' ? 'e.g. Breakouts' : 'e.g. Swing ideas'} />
          <div className="watchlist-menu-form-actions">
            <button type="button" className="watchlist-btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
            <button type="submit" className="watchlist-btn-primary" disabled={!draft.trim()}>{editing === 'rename' ? 'Rename' : 'Create'}</button>
          </div>
        </form> : <>
          <div className="watchlist-menu-label">Watchlists</div>
          <div role="group" aria-label="Watchlists">
            {store.lists.map(list => <button key={list.id} type="button" className="watchlist-menu-row" aria-pressed={!view && list.id === store.activeId}
              onClick={() => { onSwitch(list.id); close(); }}>
              <span className="watchlist-menu-check">{!view && list.id === store.activeId && <Check size={13} />}</span>
              <span className="watchlist-menu-name">{list.name}</span>
              <span className="watchlist-menu-count">{list.items.filter(item => !item.startsWith('###')).length}</span>
            </button>)}
          </div>
          <div className="watchlist-menu-divider" />
          <div className="watchlist-menu-label">Flagged</div>
          <div role="group" aria-label="Flagged lists">
            {FLAG_COLORS.map(flag => {
              const total = flaggedSymbols(flags, flag.id).length;
              return <button key={flag.id} type="button" className="watchlist-menu-row" aria-pressed={view === flag.id}
                onClick={() => { onView(flag.id); close(); }}>
                <span className="watchlist-menu-check">{view === flag.id ? <Check size={13} /> : <span className="watchlist-flag-dot" style={{background: flag.color}} />}</span>
                <span className="watchlist-menu-name">{flag.label} list</span>
                <span className="watchlist-menu-count">{total}</span>
              </button>;
            })}
          </div>
          <div className="watchlist-menu-divider" />
          <button type="button" className="watchlist-menu-row" onClick={() => startEditing('new')}><FolderPlus size={13} /><span className="watchlist-menu-name">Create new list…</span></button>
          {!view && <>
            <button type="button" className="watchlist-menu-row" onClick={() => startEditing('rename', activeName)}><Pencil size={13} /><span className="watchlist-menu-name">Rename “{activeName}”…</span></button>
            <button type="button" className="watchlist-menu-row" onClick={() => startEditing('section')}><Heading size={13} /><span className="watchlist-menu-name">Add section…</span></button>
            <button type="button" className="watchlist-menu-row" disabled={!count} onClick={() => { onClear(); close(); }}><Eraser size={13} /><span className="watchlist-menu-name">Clear list</span></button>
            <button type="button" className="watchlist-menu-row is-danger" onClick={() => { onDelete(); close(); }}>
              <Trash2 size={13} /><span className="watchlist-menu-name">{store.lists.length > 1 ? 'Delete list' : 'Clear entire list'}</span>
            </button>
          </>}
        </>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
