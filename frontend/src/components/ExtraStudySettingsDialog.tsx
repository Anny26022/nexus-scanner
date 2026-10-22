import { useState } from 'react';
import { ChartDialog } from './ChartDialog';
import { Button } from './Button';
import { studyLineColor, studyParams, type ExtraStudyDef, type ExtraStudyState } from '../chart/extraStudies';

/** Inputs and line colours for any registry indicator. */
export function ExtraStudySettingsDialog({def, state, onApply, onClose}: {
  def: ExtraStudyDef;
  state?: ExtraStudyState;
  onApply: (next: ExtraStudyState) => void;
  onClose: () => void;
}) {
  const [params, setParams] = useState(() => studyParams(def, state));
  const [colors, setColors] = useState<Record<string, string>>(() => Object.fromEntries(def.lines.map(line => [line.key, studyLineColor(line, state)])));
  const apply = () => {
    onApply({enabled: state?.enabled ?? true, params: studyParams(def, {enabled: true, params}), colors});
    onClose();
  };
  const reset = () => {
    setParams(studyParams(def));
    setColors(Object.fromEntries(def.lines.map(line => [line.key, line.color])));
  };

  return <ChartDialog title={`${def.label} settings`} className="extra-study-dialog" onClose={onClose}>
    <form className="flex w-[min(420px,calc(100vw-40px))] flex-col gap-4 px-5 pb-4 pt-4" onSubmit={event => { event.preventDefault(); apply(); }}>
      <p className="m-0 text-[12.5px] leading-relaxed text-muted">{def.description}</p>
      {def.inputs.length > 0 && <fieldset className="m-0 grid grid-cols-2 gap-3 border-0 p-0">
        <legend className="mb-2 text-[12px] font-semibold text-secondary">Inputs</legend>
        {def.inputs.map(input => <label key={input.id} className="flex flex-col gap-1 text-[12.5px] text-secondary">
          {input.label}
          <input type="number" value={params[input.id]} min={input.min} max={input.max} step={input.step ?? 1}
            onChange={event => setParams(current => ({...current, [input.id]: Number(event.target.value)}))}
            className="h-8 rounded-(--radius-md) border-0 bg-field px-2.5 text-[13px] text-text outline-none focus:bg-surface focus:shadow-(--ring)" />
        </label>)}
      </fieldset>}
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-[12px] font-semibold text-secondary">Style</legend>
        {def.lines.map(line => <label key={line.key} className="flex items-center justify-between gap-3 text-[12.5px] text-secondary">
          {line.label}
          <input type="color" aria-label={`${line.label} colour`} value={colors[line.key]}
            onChange={event => setColors(current => ({...current, [line.key]: event.target.value}))}
            className="h-7 w-10 cursor-pointer rounded-(--radius-sm) border-0 bg-transparent p-0" />
        </label>)}
      </fieldset>
      <footer className="-mx-5 mt-1 flex items-center justify-between border-t border-line px-5 pt-3">
        <Button variant="ghost" onClick={reset}>Reset to defaults</Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">Apply</Button>
        </div>
      </footer>
    </form>
  </ChartDialog>;
}
