import { ChartDialog } from './ChartDialog';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const ALT = MAC ? '⌥' : 'Alt';
const MOD = MAC ? '⌘' : 'Ctrl';

export const CHART_SHORTCUTS: ReadonlyArray<{group: string; items: ReadonlyArray<[keys: string[], label: string]>}> = [
  {group: 'Symbol', items: [
    [['A–Z'], 'Start typing a ticker to search'],
    [['/'], 'Focus symbol search'],
    [[','], 'Previous watchlist symbol'],
    [['.'], 'Next watchlist symbol'],
    [[MOD, 'K'], 'Command palette'],
  ]},
  {group: 'Timeframe', items: [
    [['1', 'D'], 'Type an interval (1D, 1W, 1M) + Enter'],
    [[ALT, '1'], 'Daily candles'],
    [[ALT, '2'], 'Weekly candles'],
    [[ALT, '3'], 'Monthly candles'],
    [['[', ']'], 'Shorter / longer timeframe'],
  ]},
  {group: 'Chart', items: [
    [['←', '→'], 'Scroll 2 bars (Ctrl/⌘ for 10)'],
    [['↑', '↓'], 'Scroll prices'],
    [['Shift', 'drag'], 'Measure price, % and bars'],
    [['+', '−'], 'Zoom in / out'],
    [['Home'], 'Jump to latest bar'],
    [[ALT, 'R'], 'Reset chart view'],
    [[ALT, 'F'], 'Fit all bars'],
    [[ALT, 'M'], 'Toggle crosshair magnet'],
    [[ALT, 'S'], 'Save chart image'],
    [[ALT, 'Enter'], 'Maximize / restore chart'],
  ]},
  {group: 'Indicators & legend', items: [
    [[ALT, 'I'], 'Open indicators'],
    [[ALT, 'L'], 'Collapse / expand legend'],
    [[ALT, 'V'], 'Hide / show all indicators'],
  ]},
  {group: 'Drawing', items: [
    [[ALT, 'H'], 'Hide / show drawings'],
    [[MOD, 'Z'], 'Undo'],
    [[MOD, 'Y'], 'Redo'],
    [[MOD, 'C'], 'Copy selected drawing'],
    [[MOD, 'V'], 'Paste drawing'],
    [[MOD, 'D'], 'Duplicate selected drawing'],
    [['Delete'], 'Delete selected drawing'],
    [['Esc'], 'Cancel drawing'],
  ]},
];

export function ChartShortcutsDialog({onClose}: {onClose: () => void}) {
  return <ChartDialog title="Keyboard shortcuts" className="chart-shortcuts-dialog" onClose={onClose}>
    <div className="grid max-h-[min(70vh,560px)] gap-x-10 gap-y-6 overflow-y-auto px-5 pb-6 pt-1 sm:grid-cols-2">
      {CHART_SHORTCUTS.map(section => <section key={section.group}>
        <h3 className="m-0 mb-1.5 text-[11.5px] font-semibold text-muted">{section.group}</h3>
        <dl className="m-0 flex flex-col">
          {section.items.map(([keys, label]) => <div key={label} className="flex min-h-8 items-center justify-between gap-4 border-b border-line text-[13px] last:border-b-0">
            <dt className="min-w-0 text-text">{label}</dt>
            <dd className="m-0 flex shrink-0 gap-1">{keys.map(key => <kbd key={key}
              className="min-w-[22px] rounded-md bg-field px-1.5 py-0.5 text-center font-sans text-[11.5px] font-medium text-secondary shadow-(--shadow-control)">{key}</kbd>)}</dd>
          </div>)}
        </dl>
      </section>)}
    </div>
  </ChartDialog>;
}
