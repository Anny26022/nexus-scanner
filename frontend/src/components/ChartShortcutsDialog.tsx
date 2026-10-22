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
    [[ALT, '1'], 'Daily candles'],
    [[ALT, '2'], 'Weekly candles'],
    [[ALT, '3'], 'Monthly candles'],
    [['[', ']'], 'Shorter / longer timeframe'],
  ]},
  {group: 'Chart', items: [
    [['←', '→'], 'Move through bars'],
    [['+', '−'], 'Zoom in / out'],
    [['Home'], 'Jump to latest bar'],
    [[ALT, 'R'], 'Reset chart view'],
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
    [['Delete'], 'Delete selected drawing'],
    [['Esc'], 'Cancel drawing'],
  ]},
];

export function ChartShortcutsDialog({onClose}: {onClose: () => void}) {
  return <ChartDialog title="Keyboard shortcuts" className="chart-shortcuts-dialog" onClose={onClose}>
    <div className="grid max-h-[min(70vh,560px)] gap-x-8 gap-y-5 overflow-y-auto px-5 pb-5 pt-4 sm:grid-cols-2 lg:w-[680px]">
      {CHART_SHORTCUTS.map(section => <section key={section.group}>
        <h3 className="m-0 mb-2 text-[12px] font-semibold text-muted">{section.group}</h3>
        <dl className="m-0 flex flex-col gap-1.5">
          {section.items.map(([keys, label]) => <div key={label} className="flex items-center justify-between gap-4 text-[12.5px]">
            <dt className="text-secondary">{label}</dt>
            <dd className="m-0 flex shrink-0 gap-1">{keys.map(key => <kbd key={key}
              className="min-w-[22px] rounded-md bg-field px-1.5 py-0.5 text-center font-sans text-[11.5px] font-medium text-text shadow-(--shadow-control)">{key}</kbd>)}</dd>
          </div>)}
        </dl>
      </section>)}
    </div>
  </ChartDialog>;
}
