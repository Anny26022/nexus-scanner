import { useMemo, useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import type { ActiveCondition } from '../types/screener';
import { POPULAR_SCANS, SCAN_CATEGORIES, SCAN_LIBRARY, type LibraryScan } from '../data/presetCatalog';
import type { SavedScan } from '../utils/savedScans';

const MINE = 'My scans', ALL = 'All';

const matches = (scan: LibraryScan, query: string) =>
  `${scan.name} ${scan.description} ${scan.category} ${scan.aka.join(' ')} ${scan.rules.join(' ')}`.toLowerCase().includes(query);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The scan library: curated scans by category, the user's own saved scans, and today's match counts. */
export function ScanLibrary({selected, counts, pending, saved, onToggle, onUseSaved, onDeleteSaved}: {
  selected: Record<string, ActiveCondition>;
  counts?: Record<string, number>;
  /** Scans whose published data has not reached this snapshot yet. */
  pending?: ReadonlySet<string>;
  saved: SavedScan[];
  onToggle: (scan: LibraryScan) => void;
  onUseSaved: (scan: SavedScan) => void;
  onDeleteSaved: (scan: SavedScan) => void;
}) {
  const [tab, setTab] = useState(ALL);
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const chosen = useMemo(() => new Set(Object.values(selected).map(condition => condition.conditionId)), [selected]);

  const sections = useMemo((): [string, LibraryScan[]][] => {
    if (tab === MINE) return [];
    const pool = SCAN_LIBRARY.filter(scan => (tab === ALL || scan.category === tab) && (!query || matches(scan, query)));
    if (query || tab !== ALL) return [[query ? 'Results' : tab, pool]];
    const popular = POPULAR_SCANS.map(id => SCAN_LIBRARY.find(scan => scan.id === id)!).filter(Boolean);
    return [['Popular', popular], ...SCAN_CATEGORIES.map(category =>
      [category, pool.filter(scan => scan.category === category)] as [string, LibraryScan[]])];
  }, [tab, query]);
  const mine = saved.filter(scan => !query || scan.name.toLowerCase().includes(query));
  const showMine = tab === MINE || (tab === ALL && mine.length > 0);

  return <div className="scan-library">
    <div className="scan-library-bar">
      <label className="query-input scan-library-search">
        <input aria-label="Search scans" placeholder="Search scans — try “gainers” or “breakout”" value={search} onChange={event => setSearch(event.target.value)} />
      </label>
      <div className="scan-library-tabs" role="group" aria-label="Scan categories">
        {[ALL, MINE, ...SCAN_CATEGORIES].map(name => <button key={name} type="button" className="filter-category-btn"
          aria-pressed={tab === name} onClick={() => setTab(name)}>
          {name}{name === MINE && saved.length > 0 && <span className="filter-category-badge" aria-hidden="true">{saved.length}</span>}
        </button>)}
      </div>
    </div>

    {showMine && <section className="scan-section" aria-label={MINE}>
      <h3>{MINE}</h3>
      {mine.length ? <div className="scan-grid">{mine.map(scan => <article key={scan.id} className="scan-card scan-card-saved">
        <button type="button" className="scan-card-main" onClick={() => onUseSaved(scan)}
          aria-label={`${scan.conditions.length === 1 ? 'Add' : 'Load'} ${scan.name}`}>
          <span className="scan-card-name">{scan.name}</span>
          <span className="scan-card-text">{scan.conditions.length === 1 ? 'Saved filter · adds to this screen'
            : `${plural(scan.conditions.length, 'filter')} · ${scan.matchMode === 'all' ? 'all must match' : 'any can match'} · replaces this screen`}</span>
        </button>
        <button type="button" className="icon-button scan-card-delete" aria-label={`Delete ${scan.name}`} title="Delete" onClick={() => onDeleteSaved(scan)}>
          <Trash2 size={14} strokeWidth={1.8} />
        </button>
      </article>)}</div>
        : <p className="scan-empty">{query ? 'No saved scans match.' : 'Nothing saved yet. Pick filters, then use “Save as scan” below, or the bookmark on any filter.'}</p>}
    </section>}

    {sections.map(([title, scans]) => scans.length > 0 && <section key={title} className="scan-section" aria-label={title}>
      <h3>{title}</h3>
      <div className="scan-grid">{scans.map(scan => {
        const on = chosen.has(scan.id), count = counts?.[scan.id], waiting = !on && pending?.has(scan.id);
        return <button key={`${title}:${scan.id}`} type="button" role="checkbox" aria-checked={on} aria-label={scan.name} className="scan-card"
          data-selected={on} disabled={waiting} title={scan.rules.join('\n')} onClick={() => onToggle(scan)}>
          <span className="scan-card-head">
            <span className="scan-card-name">{scan.name}</span>
            <span className="scan-card-check" aria-hidden="true">{on && <Check size={12} strokeWidth={2.6} />}</span>
          </span>
          <span className="scan-card-text">{scan.description}</span>
          <span className="scan-card-meta">
            <span>{scan.horizon}</span>
            {waiting ? <span className="scan-count is-quiet">After the next data refresh</span>
              : count != null && <span className={count ? 'scan-count' : 'scan-count is-quiet'}>{count ? `${count.toLocaleString('en-IN')} today` : 'None today'}</span>}
          </span>
        </button>;
      })}</div>
    </section>)}

    {tab !== MINE && sections.every(([, scans]) => !scans.length) && <div className="data-state"><h2>No matching scans</h2><p>Try another word or category.</p></div>}
  </div>;
}
