import { conditionValidationError, isIntegerParameter, numericInputValue } from '../utils/conditionValidation';
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from './Dialog';
import { hasUnavailableConditions, UnavailableConditions, UNAVAILABLE_CONDITIONS_MESSAGE } from './UnavailableConditions';
import { X, SlidersHorizontal, Library, ChevronDown, Info, Bookmark } from 'lucide-react';
import { ConditionCategory, ActiveCondition, MatchMode, ConditionDef, ParameterSpec } from '../types/screener';
import { NEXUS_CONDITION_CATALOG, FILTER_CONDITION_CATALOG, REDUNDANT_CATALOG_CONDITIONS } from '../data/conditionCatalog';
import { breadthMetricDefault } from '../data/breadthMetricDefaults';
import { PRESET_CATALOG, RECIPES, recipeMetrics, type LibraryScan } from '../data/presetCatalog';
import { ScanLibrary } from './ScanLibrary';
import { ScanEligibility } from './ScanEligibility';
import { useLocalStorageState } from '../hooks/useLocalStorageState';
import { SAVED_SCANS_KEY, parseSavedScans, scanInstances, upsertSavedScan, type SavedScan } from '../utils/savedScans';
import { presetEligibilitySummary } from '../data/presetEligibility';
import { availableFilterParameters, isAvailableCondition } from '../utils/filterAvailability';
import { comparisonLabel, filterLogicHint, parameterPresentation, RANGE_FILTERS } from '../utils/filterPresentation';
import { MOVING_AVERAGE_RULES } from '../data/movingAverageRules';
import technicalConfigurations from '../data/snapshotTechnicals.json';
import {isExtendedCondition, extendedMetrics} from '../data/extendedMetrics';
import type { FilterChoices } from '../api/snapshotEngine';
import { SNAPSHOT_MA_PERIODS } from '../api/snapshotScreen';
import {etfConditionCatalog, etfCategoryTabs, etfGroup, etfFieldLabel, isEtfCondition} from '../data/etfFields';
import { Button } from './Button';
import { portalContainer } from '../embedding';

interface ScreenerModalProps {
  isOpen: boolean;
  etf?: boolean;
  onClose: () => void;
  activeConditionsMap: Record<string, ActiveCondition>;
  matchMode: MatchMode;
  onApply: (map: Record<string, ActiveCondition>, mode: MatchMode) => void;
  choices?: FilterChoices;
  choicesLoading?: boolean;
  choicesError?: boolean;
  retryChoices?: () => void;
}

/** Every library scan carries the same editable eligibility floors. */
const LIBRARY_IDS = new Set(PRESET_CATALOG.map(def => def.id));

const CATEGORY_TABS: Array<{ id: ConditionCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'trend', label: 'Technicals' },
  { id: 'momentum', label: 'Momentum & Volume' },
  { id: 'range', label: 'Range & Patterns' },
  { id: 'relative_strength', label: 'Relative Strength' },
  { id: 'fundamentals', label: 'Fundamentals' },
  { id: 'liquidity', label: 'Market & Liquidity' },
];

const readableUnit = (unit?: string) => {
  const labels: Record<string, string> = {
    p: 'periods',
    d: 'days',
    pp: 'pts',
    x: '×',
  };
  return unit ? (labels[unit] ?? unit) : '';
};

const MultiSelectDropdown = ({ options, value, onChange, label, single = false, searchable = false }: {options: NonNullable<ParameterSpec['options']>; value: string[]; onChange: (value: string[]) => void; label: string; single?: boolean; searchable?: boolean}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [menuPosition, setMenuPosition] = useState<{top: number; left: number; maxHeight: number} | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const toggleMenu = () => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setSearch('');
    const menuHeight = Math.min(options.length * 32 + (searchable ? 52 : 8), 240);
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const opensAbove = below < Math.min(menuHeight, 100) && above > below;
    const maxHeight = Math.max(48, Math.min(menuHeight, opensAbove ? above : below));
    const width = Math.min(200, window.innerWidth - 24);
    setMenuPosition({
      top: opensAbove ? rect.top - maxHeight - 4 : rect.bottom + 4,
      left: Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12),
      maxHeight,
    });
    setIsOpen(true);
  };

  const toggle = (val: string) => {
    if (single) { onChange([val]); setIsOpen(false); trigger.current?.focus(); return; }
    const arr = value || [];
    if (arr.includes(val)) {
      onChange(arr.filter((v: string) => v !== val));
    } else {
      onChange([...arr, val]);
    }
  };
  
  return (
    <div className="relative" onKeyDown={event => {
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen(false);
        trigger.current?.focus();
      }
    }}>
      <button 
        ref={trigger} type="button" disabled={!options.length} title={value.join(', ')} aria-label={`${label}: ${value?.length ? `${value.length} selected` : 'Select options'}`} aria-expanded={isOpen}
        onClick={toggleMenu}
        className="filter-select-trigger bg-white border border-gray-200 hover:border-teal-500 rounded-lg px-2.5 py-1 font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500/20 max-w-[140px] shrink-0 truncate transition-all cursor-pointer flex items-center justify-between gap-1.5 shadow-sm"
      >
        <span className="truncate">{value?.length ? single ? options.find(option => option.value === value[0])?.label ?? value[0] : `${value.length} selected` : 'Select...'}</span>
        <ChevronDown size={12} className="text-gray-400 shrink-0" />
      </button>
      
      {isOpen && (
        createPortal(<>
          <div className="fixed inset-0 z-[120]" onClick={() => setIsOpen(false)} />
          <div data-escape-layer className="filter-choice-menu fixed z-[121] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 text-[12px] shadow-lg"
            role="group" aria-label={label} style={{top:menuPosition?.top,left:menuPosition?.left,maxHeight:menuPosition?.maxHeight,width:200}}>
             {searchable && <div className="filter-choice-search"><input autoFocus aria-label={`Search ${label}`} placeholder="Search…" value={search} onChange={event => setSearch(event.target.value)} /></div>}
             {options.filter(option => option.label.toLowerCase().includes(search.trim().toLowerCase())).map(o => {
               const selected = value?.includes(o.value);
               return (
                 <label
                   key={o.value}
                   className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors ${selected ? 'bg-teal-50 text-teal-800' : 'text-gray-700 hover:bg-gray-50'}`}
                 >
                   <input type={single ? 'radio' : 'checkbox'} checked={selected} onChange={() => toggle(String(o.value))} className="w-3 h-3 rounded border-gray-300 text-teal-600" />
                   <span className="truncate font-medium">{o.label}</span>
                 </label>
               );
             })}
             {search && !options.some(option => option.label.toLowerCase().includes(search.trim().toLowerCase())) && <p className="px-2 py-1">No matches</p>}
          </div>
        </>, trigger.current?.closest('[role="dialog"]') ?? portalContainer() ?? document.body)
      )}
    </div>
  );
};

interface FilterRowProps {
  def: ConditionDef;
  ruleKey: string;
  active?: ActiveCondition;
  showParameters: boolean;
  toggle: (def: ConditionDef, ruleKey: string) => void;
  updateParam: (condId: string, paramId: string, value: any) => void;
  onSave?: (condition: ActiveCondition, label: string) => void;
}

interface FilterParameterProps {
  defId: string;
  parameters: ActiveCondition['parameters'];
  p: ParameterSpec;
  val: any;
  updateParam: FilterRowProps['updateParam'];
  label?: string;
  prefix?: string;
  unit?: string;
}

const FilterParameter = memo(function FilterParameter({ defId, parameters, p, val, updateParam, label, prefix, unit }: FilterParameterProps) {
  const presentation = parameterPresentation(defId, p);
  const visibleLabel = label ?? presentation.label;
  const visiblePrefix = prefix ?? presentation.prefix;
  const visibleUnit = unit ?? presentation.unit;
  let control: React.ReactNode;
  if (p.type === 'boolean') {
    control = <input aria-label={p.label} type="checkbox" checked={!!val}
      onChange={e => updateParam(defId, p.id, e.target.checked)} />;
  } else if (p.type === 'string') {
    if (p.options) {
      const single = defId === 'INDEX_MEMBERSHIP';
      const values = (Array.isArray(val) ? val : single ? [String(val ?? '')] : String(val ?? '').split(','))
        .map(value => String(value).trim().toUpperCase()).filter(Boolean);
      const options = p.options.map(option => ({...option, value:String(option.value).toUpperCase()}));
      for (const value of values) if (!options.some(option => option.value === value)) options.push({value, label:value});
      control = <MultiSelectDropdown label={p.label} options={options} value={values} searchable={defId !== 'MA_STACK'} single={single}
        onChange={selected => updateParam(defId, p.id, single ? selected[0] ?? '' : defId === 'MA_STACK' ? selected.join(', ') : selected)} />;
    } else control = <input aria-label={p.label} value={val ?? ''}
      onChange={e => updateParam(defId, p.id, e.target.value)}
      className="w-24 bg-white border border-gray-200 rounded-md px-1.5 py-0.5 text-[11px]" />;
  } else if (p.type === 'multiselect') {
    control = <MultiSelectDropdown searchable={isEtfCondition(defId)} label={p.label} options={p.options || []} value={val}
      onChange={(newVal: string[]) => updateParam(defId, p.id, newVal)} />;
  } else if (p.type === 'select') {
    control = <select
        value={val}
        aria-label={p.label}
        onChange={(e) => updateParam(defId, p.id, e.target.value)}
        className="px-2 py-1 font-medium shrink-0 truncate cursor-pointer"
      >
        {(p.options || []).map((opt) => (
          <option key={opt.value} value={opt.value} disabled={!isAvailableCondition({
            instanceId: defId, conditionId: defId, parameters: {...parameters, [p.id]: opt.value},
          })}>
            {['comparison', 'operator', 'op'].includes(p.id) ? comparisonLabel(defId, opt.value, opt.label) : opt.label}
          </option>
        ))}
      </select>;
  } else {
    control = <input
      type="number"
      value={val}
      onChange={(e) => updateParam(defId, p.id, numericInputValue(e.target.value))}
      min={p.min}
      max={p.max}
      step={p.step ?? (isIntegerParameter(p) ? 1 : 0.1)}
      aria-label={p.label}
      className="px-2 py-1 font-semibold text-center"
    />;
  }

  return (
    <div key={p.id} title={p.type === 'select' ? p.options?.find(option => String(option.value) === String(val))?.label ?? p.label : p.description ?? p.label} className="parameter-control">
      {visibleLabel && <span className="parameter-label">{visibleLabel}</span>}
      <div className="parameter-value">{visiblePrefix && <span className="parameter-sign" aria-hidden="true">{visiblePrefix}</span>}{control}
        {visibleUnit && <span className="parameter-unit">{readableUnit(visibleUnit)}</span>}
      </div>
    </div>
  );
});

const FilterRule = memo(function FilterRule({def, parameters, updateParam}: {
  def: ConditionDef; parameters: ActiveCondition['parameters']; updateParam: FilterRowProps['updateParam'];
}) {
  const fixed: Record<string, unknown> = {...technicalConfigurations.find(config => config.id === def.id)?.fixed,
    ...(isEtfCondition(def.id) && def.parameters[0]?.options?.length === 1 && parameters.metric === def.parameters[0].options[0].value ? {metric:def.parameters[0].options[0].value} : {})};
  if (def.parameters.every(parameter => Object.hasOwn(fixed, parameter.id))) return null;
  const field = (p: ParameterSpec, display: Pick<FilterParameterProps, 'label' | 'prefix' | 'unit'> = {}) => {
    if (Object.hasOwn(fixed, p.id)) return null;
    const savedMetric = isExtendedCondition(def.id) && p.id === 'metric'
      ? extendedMetrics.find(metric => metric.id === parameters.metric)
      : isEtfCondition(def.id) && p.id === 'metric' && etfGroup(def.id)?.fields.includes(parameters.metric)
        ? {id:parameters.metric, label:etfFieldLabel(parameters.metric)} : undefined;
    const parameter = savedMetric && !p.options?.some(option => option.value === savedMetric.id)
      ? {...p, options:[...(p.options ?? []), {value:savedMetric.id,label:savedMetric.label}]} : p;
    return <FilterParameter key={p.id} defId={def.id} parameters={parameters} p={parameter} val={parameters[p.id]} updateParam={updateParam} {...display} />;
  };
  const byId = (id: string, display: Pick<FilterParameterProps, 'label' | 'prefix' | 'unit'> = {}) => {
    const p = def.parameters.find(p => p.id === id);
    return p ? field(p, display) : null;
  };

  if (def.id === 'PRICE_VS_MAS') return <div className="ma-rule-picker">
    {byId('rules', {label:''})}
    <div className="ma-selected-rules">{(parameters.rules as string[]).map(value => {
      const rule = MOVING_AVERAGE_RULES.find(rule => rule.value === value);
      return rule ? <span key={value}>{rule.label}<button type="button" aria-label={`Remove ${rule.label}`}
        onClick={() => updateParam(def.id, 'rules', parameters.rules.filter((item: string) => item !== value))}><X size={12} /></button></span> : null;
    })}</div>
  </div>;

  if (RANGE_FILTERS.includes(def.id)) {
    const min = def.parameters.find(p => p.id.startsWith('min'))!;
    const max = def.parameters.find(p => p.id.startsWith('max'))!;
    const unit = def.id === 'mom_rvol' ? 'x' : def.id === 'fund_free_float' ? '%' : undefined;
    return <div className="filter-parameters"><span className="rule-word">Between</span>
      {field(min, {label:'', prefix:'', unit})}<span className="rule-word">to</span>{field(max, {label:'', prefix:'', unit})}
      {def.parameters.filter(p => p !== min && p !== max).map(p => field(p))}
    </div>;
  }

  if (['PRICE_VS_EMA', 'PRICE_VS_SMA'].includes(def.id)) return <div className="filter-parameters">
    <span className="rule-word">Close</span>{byId('comparison', {label:''})}
    {byId('period', {label:'', unit:def.id === 'PRICE_VS_EMA' ? 'EMA' : 'SMA'})}
    <span className="rule-word">for ≥</span>{byId('persistDays', {label:'', unit:'sessions'})}
  </div>;

  if (def.id === 'AVG_TURNOVER') return <div className="filter-parameters">
    <span className="rule-word">Avg. daily turnover</span>{byId('comparison', {label:''})}
    {byId('valueCr', {label:'', unit:'₹ Cr'})}<span className="rule-word">over</span>
    {byId('lookbackDays', {label:'', unit:'sessions'})}
  </div>;

  if (def.id === 'trend_price_vs_ma') return <div className="filter-parameters">
    <span className="rule-word">Close</span>{byId('operator', {label:''})}{byId('maType', {label:''})}{byId('maPeriod', {label:''})}
    {parameters.operator === 'within_pct' && byId('thresholdPct', {label:'Distance ≤', prefix:''})}
  </div>;

  const comparison = def.parameters.find(p => p.id === 'comparison');
  const metrics = comparison ? def.parameters.filter(p => ['metric','window','maType'].includes(p.id)) : [];
  const remaining = def.parameters.filter(p => p !== comparison && !metrics.includes(p));
  if (comparison) remaining.sort((a, b) => Number(['value','valueCr','pct','minChangePct','days','ratio'].includes(b.id))
    - Number(['value','valueCr','pct','minChangePct','days','ratio'].includes(a.id)));
  return <div className="filter-parameters">
    {metrics.map(p => field(p, {label:''}))}
    {comparison && field(comparison, {label:''})}
    {remaining.map(p => field(p, {
      label: comparison && ['value','valueCr','pct'].includes(p.id) ? '' : p.label,
    }))}
  </div>;
});

// Unchanged rows retain the same definition, condition and callback references.
const FilterRow = memo(function FilterRow({ def, ruleKey, active, showParameters, toggle, updateParam, onSave }: FilterRowProps) {
  const updateRule = useCallback((_defId: string, paramId: string, value: unknown) =>
    updateParam(ruleKey, paramId, value), [ruleKey, updateParam]);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const checked = !!active;
  const supportedParameters = availableFilterParameters(def);
  const editable = supportedParameters !== null || Boolean(active && isAvailableCondition(active));
  const available = active ? isAvailableCondition(active) : editable;
  const parameters = active?.parameters ?? (def.id === 'PRICE_VS_MAS' ? {rules:[]} : supportedParameters) ?? Object.fromEntries(def.parameters.map(p => [p.id, p.defaultValue]));
  const logicHint = filterLogicHint(def.id, parameters);
  const description = !showParameters ? `${def.description}. Eligibility: ${presetEligibilitySummary(parameters)}.`
    : logicHint ? `${def.description} ${logicHint}` : def.description;

  return (
    <div className="filter-row" data-condition-id={def.id} data-active={checked} data-unavailable={!available} data-preset={!showParameters}>
      <label className="flex items-center gap-2.5 min-w-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={!editable && !checked}
          onChange={() => toggle(def, ruleKey)}
          className="rounded border-gray-300 text-teal-600 focus:ring-teal-500 transition-all"
        />
        <span title={def.description}>
          {def.label}{showParameters ? ':' : ''}
        </span>
      </label>

      <button type="button" className="preset-info-button" data-tooltip={description}
        aria-label={`${descriptionOpen ? 'Hide' : 'Show'} ${def.label} description`}
        aria-expanded={descriptionOpen} onClick={() => setDescriptionOpen(open => !open)}>
        <Info size={15} strokeWidth={1.8} />
      </button>
      {onSave && active && available && <button type="button" className="preset-info-button filter-save-button" title="Save this filter to My scans"
        aria-label={`Save ${def.label} filter`} onClick={() => onSave(active, def.label)}>
        <Bookmark size={14} strokeWidth={1.8} />
      </button>}

      {editable && showParameters && def.parameters && def.parameters.length > 0 && (
        <FilterRule def={def} parameters={parameters} updateParam={updateRule} />
      )}
      {editable && showParameters && def.id === 'MA_STACK' && logicHint && <p className="filter-logic-hint">{logicHint}</p>}
      {descriptionOpen && <p className={showParameters ? 'filter-logic-hint' : 'preset-description'}>{description}</p>}
    </div>
  );
});

export const ScreenerModal: React.FC<ScreenerModalProps> = ({
  isOpen,
  onClose,
  activeConditionsMap,
  matchMode,
  onApply,
  choices,
  choicesLoading,
  choicesError,
  retryChoices,
  etf = false,
}) => {
  const categoryTabs = etf ? etfCategoryTabs : CATEGORY_TABS;
  const [category, setCategory] = useState<ConditionCategory | 'all'>('all');
  const [localMap, setLocalMap] = useState<Record<string, ActiveCondition>>(() => Object.fromEntries(
    Object.entries(activeConditionsMap).filter(([, condition]) => !(condition.conditionId === 'PRICE_VS_MAS'
      && Array.isArray(condition.parameters.rules) && condition.parameters.rules.length === 0)),
  ));
  const [localMode, setLocalMode] = useState<MatchMode>(matchMode);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'custom' | 'presets'>('custom');
  const [storedScans, setStoredScans] = useLocalStorageState<unknown>(SAVED_SCANS_KEY, []);
  const savedScans = parseSavedScans(storedScans);
  const [saving, setSaving] = useState<{conditions: ActiveCondition[]; name: string} | null>(null);
  const [notice, setNotice] = useState('');
  // Library scans built on published daily metrics wait until the snapshot carries them.
  const pendingScans = useMemo(() => !choices ? undefined : new Set([...RECIPES.keys()].filter(id =>
    recipeMetrics(id).some(metric => !choices.TRADINGVIEW_METRIC?.includes(metric)))), [choices]);
  const customCatalog = useMemo(() => (etf ? etfConditionCatalog : FILTER_CONDITION_CATALOG).map(def => {
    if (isEtfCondition(def.id)) {
      const options = def.parameters[0].options?.filter(option => choices?.ETF_FIELDS?.includes(option.value)) ?? [];
      return {...def, parameters:def.parameters.map(parameter => parameter.id === 'metric'
        ? {...parameter, options, defaultValue:options[0]?.value ?? parameter.defaultValue} : parameter)};
    }
    if (isExtendedCondition(def.id)) return {...def, parameters:def.parameters.map(parameter => {
      if (parameter.id !== 'metric') return parameter;
      const options = parameter.options?.filter(option => choices?.TRADINGVIEW_METRIC?.includes(option.value)) ?? [];
      return {...parameter, options, defaultValue:options[0]?.value ?? parameter.defaultValue};
    })};
    const raw = choices?.[def.id as keyof FilterChoices];
    const values = def.id === 'MA_STACK' ? SNAPSHOT_MA_PERIODS.map(String) : Array.isArray(raw) ? raw : [];
    if (def.id !== 'MA_STACK' && !['SECTOR','INDUSTRY','SERIES','PRICE_BAND','INDEX_MEMBERSHIP'].includes(def.id)) return def;
    return {...def, parameters:def.parameters.map(parameter => parameter.type === 'string'
      ? {...parameter, options:(values ?? []).map(value => ({value, label:def.id === 'PRICE_BAND' && /^\d+$/.test(value) ? `${value}%` : value}))} : parameter)};
  }), [choices, etf]);

  const toggle = useCallback((def: ConditionDef, ruleKey: string) => {
    setLocalMap((prev) => {
      if (prev[ruleKey]) {
        const next = { ...prev };
        delete next[ruleKey];
        return next;
      }
      const params = availableFilterParameters(def);
      if (!params) return prev;
      return {
        ...prev,
        [ruleKey]: { instanceId: crypto.randomUUID(), conditionId: def.id, parameters: params },
      };
    });
  }, []);

  const updateParam = useCallback((condId: string, paramId: string, value: any) => {
    setLocalMap((prev) => {
      const existing = prev[condId];
      const definitionId = existing?.conditionId ?? condId;
      if (definitionId === 'PRICE_VS_MAS' && paramId === 'rules' && Array.isArray(value) && value.length === 0) {
        const next = {...prev};
        delete next[condId];
        return next;
      }
      const def = (isEtfCondition(definitionId) ? customCatalog : NEXUS_CONDITION_CATALOG).find((c) => c.id === definitionId);
      if (!existing && def) {
        const params = availableFilterParameters(def);
        if (!params) return prev;
        params[paramId] = value;
        if (definitionId === 'MARKET_BREADTH' && paramId === 'metric') {
          params.value = breadthMetricDefault(value);
        }
        return {
          ...prev,
          [condId]: { instanceId: crypto.randomUUID(), conditionId: definitionId, parameters: params },
        };
      }
      if (!existing) return prev;
      const parameters = { ...existing.parameters, [paramId]: value };
      if (isEtfCondition(definitionId) && paramId === 'metric') parameters.values = [];
      if (definitionId === 'MARKET_BREADTH' && paramId === 'metric') {
        parameters.value = breadthMetricDefault(value);
      }
      return {
        ...prev,
        [condId]: { ...existing, parameters },
      };
    });
  }, [customCatalog]);

  const addRule = useCallback((def: ConditionDef) => {
    const parameters = availableFilterParameters(def);
    if (!parameters) return;
    const instanceId = crypto.randomUUID();
    setLocalMap(current => ({...current, [instanceId]: {instanceId, conditionId:def.id, parameters}}));
  }, []);

  const toggleScan = useCallback((scan: LibraryScan) => setLocalMap(current => {
    if (Object.values(current).some(condition => condition.conditionId === scan.id)) {
      return Object.fromEntries(Object.entries(current).filter(([, condition]) => condition.conditionId !== scan.id));
    }
    const def = PRESET_CATALOG.find(item => item.id === scan.id);
    const parameters = def && availableFilterParameters(def);
    return parameters ? {...current, [scan.id]: {instanceId: crypto.randomUUID(), conditionId: scan.id, parameters}} : current;
  }), []);
  const loadSaved = (scan: SavedScan) => {
    if (scan.conditions.length === 1) setLocalMap(current => ({...current, ...scanInstances(scan)}));
    else { setLocalMap(scanInstances(scan)); setLocalMode(scan.matchMode); }
    setNotice(scan.conditions.length === 1 ? `Added “${scan.name}”` : `Loaded “${scan.name}”`);
  };
  const saveFilter = useCallback((condition: ActiveCondition, label: string) => setSaving({conditions: [condition], name: label}), []);
  const commitSave = (event: React.FormEvent) => {
    event.preventDefault();
    if (!saving?.name.trim()) return;
    const replacing = savedScans.some(scan => scan.name.toLowerCase() === saving.name.trim().toLowerCase());
    setStoredScans(upsertSavedScan(savedScans, saving.name, saving.conditions, localMode));
    setNotice(replacing ? `Updated “${saving.name.trim()}”` : `Saved “${saving.name.trim()}”`);
    setSaving(null);
  };

  if (!isOpen) return null;

  const catalogToUse = activeTab === 'custom' ? customCatalog : PRESET_CATALOG;

  const filtered = catalogToUse.filter((c) => {
    if ((isExtendedCondition(c.id) || isEtfCondition(c.id)) && !c.parameters.find(p => p.id === 'metric')?.options?.length
        && !Object.values(localMap).some(condition => condition.conditionId === c.id)) return false;
    if ((c.id === 'fund_roe' || REDUNDANT_CATALOG_CONDITIONS.has(c.id)) && !Object.values(localMap).some(condition => condition.conditionId === c.id)) return false;
    return (activeTab === 'presets' || category === 'all' || c.category === category)
      && (!search.trim() || `${c.label} ${c.description} ${c.parameters.flatMap(p => p.options?.map(o => o.label) ?? []).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()));
  });

  const handleReset = () => setLocalMap({});

  const validationError = hasUnavailableConditions(localMap) ? UNAVAILABLE_CONDITIONS_MESSAGE : conditionValidationError(localMap);
  const handleApply = () => {
    if (validationError) return;
    onApply(localMap, localMode);
    onClose();
  };

  return <Dialog label="Screen filters" onClose={onClose} className="filter-dialog">
    <div className="dialog-header"><div><h2>Refine your screen</h2><p>Select conditions and adjust their parameters.</p></div><button type="button" className="icon-button" aria-label="Close filters" onClick={onClose}><X size={20} /></button></div>
    <div className="filter-modal-tabs" role="group" aria-label="Filter source">
      <button aria-pressed={activeTab === 'custom'} onClick={() => {setActiveTab('custom'); setSearch('');}}><SlidersHorizontal className="inline mr-2" size={14} />Custom Filters</button>
      {!etf && <button aria-pressed={activeTab === 'presets'} onClick={() => {setActiveTab('presets'); setSearch('');}}><Library className="inline mr-2" size={14} />Scan Library</button>}
      <div className="match-mode" role="group" aria-label="Match mode"><span>Selected filters</span><button title="Every selected filter must match" aria-pressed={localMode === 'all'} onClick={() => setLocalMode('all')}>AND (All)</button><button title="At least one selected filter must match" aria-pressed={localMode === 'any'} onClick={() => setLocalMode('any')}>OR (Any)</button></div>
    </div>
    {activeTab === 'custom' && <div className="filter-modal-options">
      <div className="relative flex items-center min-w-0">
        <label className="query-input w-full">
          <input aria-label="Search filters" placeholder="Search filters" value={search} onChange={event => setSearch(event.target.value)} />
        </label>
        {search && (
          <button
            type="button"
            className="absolute right-2 text-gray-400 hover:text-gray-600 p-0.5 rounded transition-colors"
            onClick={() => setSearch('')}
            aria-label="Clear filter search"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {activeTab === 'custom' && (
        <div className="filter-categories" role="group" aria-label="Filter categories">
          {categoryTabs.map(tab => {
            const count = tab.id === 'all'
              ? Object.keys(localMap).length
              : Object.values(localMap).filter(cond => {
                  const def = customCatalog.find(c => c.id === cond.conditionId);
                  return def?.category === tab.id;
                }).length;
            return (
              <button
                key={tab.id}
                aria-pressed={category === tab.id}
                aria-label={tab.label}
                onClick={() => setCategory(tab.id)}
                className="filter-category-btn"
              >
                <span>{tab.label}</span>
                {count > 0 && <span className="filter-category-badge" aria-hidden="true">{count}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>}
    <div className="filter-modal-content">
      {choicesLoading && <p role="status" className="cell-muted">Loading filter choices…</p>}
      {choicesError && <p role="alert">Filter choices could not load. <button type="button" onClick={retryChoices}>Retry</button></p>}
      <UnavailableConditions conditions={localMap} onRemove={key => setLocalMap(current => {
        const next = {...current};
        delete next[key];
        return next;
      })} />
      {activeTab === 'presets' && <>
        <ScanEligibility scans={Object.entries(localMap).filter(([, condition]) => LIBRARY_IDS.has(condition.conditionId))}
          nameOf={id => PRESET_CATALOG.find(def => def.id === id)?.label ?? id} onChange={updateParam}
          onRemove={key => setLocalMap(current => Object.fromEntries(Object.entries(current).filter(([item]) => item !== key)))} />
        <ScanLibrary selected={localMap} counts={choices?.SCAN_COUNTS} pending={pendingScans} saved={savedScans} onToggle={toggleScan} onUseSaved={loadSaved}
          onDeleteSaved={scan => setStoredScans(savedScans.filter(item => item.id !== scan.id))} />
      </>}
      {activeTab === 'custom' && <div className="filter-rule-list">
        {(
          filtered.map((def, index) => {
            const instances = Object.entries(localMap).filter(([, condition]) => condition.conditionId === def.id);
            const repeatable = def.category === 'fundamentals' && def.parameters.length > 0
              || isEtfCondition(def.id) || isExtendedCondition(def.id) || ['mom_return', 'PRICE_CHANGE_PCT', 'FUNDAMENTAL_METRIC'].includes(def.id);
            
            const prevDef = index > 0 ? filtered[index - 1] : null;
            const showSectionDivider = category === 'all' && (!prevDef || prevDef.category !== def.category);
            const categoryTitle = showSectionDivider ? (categoryTabs.find(t => t.id === def.category)?.label ?? def.category) : null;

            return (
              <React.Fragment key={def.id}>
                {showSectionDivider && (
                  <div className="filter-section-header" role="presentation">
                    <span className="filter-section-title">{categoryTitle}</span>
                    <div className="filter-section-divider" />
                  </div>
                )}
                <div className="filter-family">
                  {(instances.length ? instances : [[def.id, undefined] as const]).map(([key, condition]) =>
                    <FilterRow key={key} ruleKey={key} def={isEtfCondition(def.id) ? {...def, parameters:def.parameters.map(parameter => {
                      if (parameter.id !== 'values') return parameter;
                      const field = condition?.parameters.metric ?? def.parameters[0].defaultValue;
                      return {...parameter, options:(choices?.ETF_VALUES?.[field] ?? []).map(value => ({value, label:choices?.ETF_LABELS?.[field]?.[value] ?? (value === 'true' ? 'Yes' : value === 'false' ? 'No' : value)}))};
                    })} : def} active={condition} showParameters={true} toggle={toggle} updateParam={updateParam} onSave={etf ? undefined : saveFilter} />)}
                  {repeatable && instances.length > 0 && availableFilterParameters(def) && <button type="button" className="add-filter-rule"
                    aria-label={`Add ${def.label} rule`} onClick={() => addRule(def)}>+ Add rule</button>}
                </div>
              </React.Fragment>
            );
          })
        )}
      </div>}
      {activeTab === 'custom' && !filtered.length && <div className="data-state"><h2>No matching filters</h2><p>Try a different category or search.</p></div>}
    </div>
    {validationError && !hasUnavailableConditions(localMap) && <p role="alert" className="px-6 py-2 text-sm text-red-600">{validationError}</p>}
    {saving ? <form className="dialog-footer scan-save-form" onSubmit={commitSave}>
      <input autoFocus aria-label="Scan name" maxLength={60} placeholder="Name this scan" value={saving.name}
        onChange={event => setSaving({...saving, name: event.target.value})} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSaving(null); } }} />
      <span className="cell-muted text-xs">{saving.conditions.length === 1 ? '1 filter' : `${saving.conditions.length} filters · ${localMode === 'all' ? 'AND' : 'OR'}`}</span>
      <div className="flex gap-2"><Button variant="secondary" onClick={() => setSaving(null)}>Cancel</Button><Button variant="primary" type="submit" disabled={!saving.name.trim()}>Save</Button></div>
    </form>
    : <div className="dialog-footer"><span className="cell-muted text-xs footer-status" role="status" title={notice || undefined}>{notice || `${Object.keys(localMap).length} selected`}</span>
      <div className="flex gap-2">
        {!etf && <Button variant="secondary" disabled={!Object.keys(localMap).length || Boolean(validationError)}
          onClick={() => setSaving({conditions: Object.values(localMap), name: ''})}><Bookmark size={14} strokeWidth={1.8} />Save as scan</Button>}
        <Button variant="secondary" onClick={handleReset}>Reset</Button><Button variant="primary" onClick={handleApply} disabled={Boolean(validationError)}>Apply</Button></div>
    </div>}
  </Dialog>;
};
