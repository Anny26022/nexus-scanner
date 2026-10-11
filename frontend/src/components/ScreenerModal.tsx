import { conditionValidationError, isIntegerParameter, numericInputValue } from '../utils/conditionValidation';
import React, { memo, useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from './Dialog';
import { hasUnavailableConditions, UnavailableConditions, UNAVAILABLE_CONDITIONS_MESSAGE } from './UnavailableConditions';
import { X, SlidersHorizontal, Library, ChevronDown, Info } from 'lucide-react';
import { ConditionCategory, ActiveCondition, MatchMode, ConditionDef, ParameterSpec } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { breadthMetricDefault } from '../data/breadthMetricDefaults';
import { PRESET_CATALOG } from '../data/presetCatalog';
import { availableFilterParameters, isAvailableCondition } from '../utils/filterAvailability';

interface ScreenerModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeConditionsMap: Record<string, ActiveCondition>;
  matchMode: MatchMode;
  onApply: (map: Record<string, ActiveCondition>, mode: MatchMode) => void;
}

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

const MultiSelectDropdown = ({ options, value, onChange, label }: {options: NonNullable<ParameterSpec['options']>; value: string[]; onChange: (value: string[]) => void; label: string}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{top: number; left: number; maxHeight: number} | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const toggleMenu = () => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = Math.min(options.length * 32 + 8, 180);
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
        ref={trigger} type="button" aria-label={`${label}: ${value?.length ? `${value.length} selected` : 'Select options'}`} aria-expanded={isOpen}
        onClick={toggleMenu}
        className="bg-white border border-gray-200 hover:border-teal-400 rounded-md px-1.5 py-0.5 text-[11px] text-gray-700 focus:outline-none max-w-[120px] shrink-0 truncate transition-colors cursor-pointer flex items-center gap-1"
      >
        <span className="truncate">{value?.length ? `${value.length} selected` : 'Select...'}</span>
        <ChevronDown size={12} />
      </button>
      
      {isOpen && (
        createPortal(<>
          <div className="fixed inset-0 z-[120]" onClick={() => setIsOpen(false)} />
          <div className="fixed z-[121] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 text-[12px] shadow-lg"
            role="group" aria-label={label} style={{top:menuPosition?.top,left:menuPosition?.left,maxHeight:menuPosition?.maxHeight,width:200}}>
             {options.map((o: any) => {
               const selected = value?.includes(o.value);
               return (
                 <label
                   key={o.value}
                   className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors ${selected ? 'bg-teal-50 text-teal-800' : 'text-gray-700 hover:bg-gray-50'}`}
                 >
                   <input type="checkbox" checked={selected} onChange={() => toggle(o.value)} className="w-3 h-3 rounded border-gray-300 text-teal-600" />
                   <span className="truncate font-medium">{o.label}</span>
                 </label>
               );
             })}
          </div>
        </>, trigger.current?.closest('dialog') ?? document.body)
      )}
    </div>
  );
};

interface FilterRowProps {
  def: ConditionDef;
  active?: ActiveCondition;
  showParameters: boolean;
  toggle: (def: ConditionDef) => void;
  updateParam: (condId: string, paramId: string, value: any) => void;
}

interface FilterParameterProps {
  defId: string;
  parameters: ActiveCondition['parameters'];
  p: ParameterSpec;
  val: any;
  updateParam: FilterRowProps['updateParam'];
}

const FilterParameter = memo(function FilterParameter({ defId, parameters, p, val, updateParam }: FilterParameterProps) {
  // The row title and each control's accessible label provide the context;
  // keeping the inputs compact makes dense filter groups easier to scan.
  let control: React.ReactNode;
  if (p.type === 'boolean') {
    control = <input aria-label={p.label} type="checkbox" checked={!!val}
      onChange={e => updateParam(defId, p.id, e.target.checked)} />;
  } else if (p.type === 'string') {
    control = <input aria-label={p.label} value={val ?? ''}
      onChange={e => updateParam(defId, p.id, e.target.value)}
      className="w-24 bg-white border border-gray-200 rounded-md px-1.5 py-0.5 text-[11px]" />;
  } else if (p.type === 'multiselect') {
    control = <MultiSelectDropdown label={p.label} options={p.options || []} value={val}
      onChange={(newVal: string[]) => updateParam(defId, p.id, newVal)} />;
  } else if (p.type === 'select') {
    control = <select
        value={val}
        aria-label={p.label}
        onChange={(e) => updateParam(defId, p.id, e.target.value)}
        className="bg-white border border-gray-200 hover:border-teal-400 rounded-md px-1.5 py-0.5 text-[11px] text-gray-700 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 max-w-[110px] shrink-0 truncate transition-colors cursor-pointer"
      >
        {(p.options || []).map((opt) => (
          <option key={opt.value} value={opt.value} disabled={!isAvailableCondition({
            instanceId: defId, conditionId: defId, parameters: {...parameters, [p.id]: opt.value},
          })}>
            {opt.label}
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
      className="w-14 bg-white border border-gray-200 hover:border-teal-400 rounded-md px-1.5 py-0.5 text-[11px] text-gray-700 text-center focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 transition-colors"
    />;
  }

  return (
    <div key={p.id} title={p.description ?? p.label} className="parameter-control">
      <span className="parameter-label">{p.label}</span>
      <div className="flex items-center gap-1">{control}
        {p.unit && <span className="text-[10px] text-gray-400 whitespace-nowrap">{readableUnit(p.unit)}</span>}
      </div>
    </div>
  );
});

// Unchanged rows retain the same definition, condition and callback references.
const FilterRow = memo(function FilterRow({ def, active, showParameters, toggle, updateParam }: FilterRowProps) {
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const checked = !!active;
  const supportedParameters = availableFilterParameters(def);
  const editable = supportedParameters !== null || Boolean(active && isAvailableCondition(active));
  const available = active ? isAvailableCondition(active) : editable;
  const parameters = active?.parameters ?? supportedParameters ?? Object.fromEntries(def.parameters.map(p => [p.id, p.defaultValue]));

  return (
    <div className="filter-row group" data-active={checked} data-unavailable={!available} data-preset={!showParameters}>
      <label className="flex items-center gap-2.5 cursor-pointer min-w-0 pt-1">
        <input
          type="checkbox"
          checked={checked}
          disabled={!editable && !checked}
          onChange={() => toggle(def)}
          className="w-3.5 h-3.5 rounded border-gray-300 text-teal-600 focus:ring-teal-500 transition-all cursor-pointer flex-shrink-0"
        />
        <span title={def.description} className={`text-[12px] font-semibold ${checked ? 'text-gray-900' : 'text-gray-600 group-hover:text-gray-800'}`}>
          {def.label}{showParameters ? ':' : ''}
        </span>
      </label>

      {!showParameters && <button type="button" className="preset-info-button" data-tooltip={def.description}
        aria-label={`${descriptionOpen ? 'Hide' : 'Show'} ${def.label} description`}
        aria-expanded={descriptionOpen} onClick={() => setDescriptionOpen(open => !open)}>
        <Info size={15} strokeWidth={1.8} />
      </button>}

      {/* Inputs keep their own compact groups and wrap inside this row when needed. */}
      {editable && showParameters && def.parameters && def.parameters.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {def.parameters.map(p => (
            <FilterParameter key={p.id} defId={def.id} parameters={parameters} p={p}
              val={parameters[p.id]} updateParam={updateParam} />
          ))}
        </div>
      )}
      {!showParameters && descriptionOpen && <p className="preset-description">{def.description}</p>}
    </div>
  );
});

export const ScreenerModal: React.FC<ScreenerModalProps> = ({
  isOpen,
  onClose,
  activeConditionsMap,
  matchMode,
  onApply,
}) => {
  const [category, setCategory] = useState<ConditionCategory | 'all'>('all');
  const [localMap, setLocalMap] = useState<Record<string, ActiveCondition>>(activeConditionsMap);
  const [localMode, setLocalMode] = useState<MatchMode>(matchMode);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'custom' | 'presets'>('custom');

  const toggle = useCallback((def: ConditionDef) => {
    setLocalMap((prev) => {
      if (prev[def.id]) {
        const next = { ...prev };
        delete next[def.id];
        return next;
      }
      const params = availableFilterParameters(def);
      if (!params) return prev;
      return {
        ...prev,
        [def.id]: { instanceId: `${def.id}_${Date.now()}`, conditionId: def.id, parameters: params },
      };
    });
  }, []);

  const updateParam = useCallback((condId: string, paramId: string, value: any) => {
    setLocalMap((prev) => {
      const def = NEXUS_CONDITION_CATALOG.find((c) => c.id === condId);
      const existing = prev[condId];
      if (!existing && def) {
        const params = availableFilterParameters(def);
        if (!params) return prev;
        params[paramId] = value;
        if (condId === 'MARKET_BREADTH' && paramId === 'metric') {
          params.value = breadthMetricDefault(value);
        }
        return {
          ...prev,
          [condId]: { instanceId: `${condId}_${Date.now()}`, conditionId: condId, parameters: params },
        };
      }
      if (!existing) return prev;
      const parameters = { ...existing.parameters, [paramId]: value };
      if (condId === 'MARKET_BREADTH' && paramId === 'metric') {
        parameters.value = breadthMetricDefault(value);
      }
      return {
        ...prev,
        [condId]: { ...existing, parameters },
      };
    });
  }, []);

  if (!isOpen) return null;

  const catalogToUse = activeTab === 'custom' ? NEXUS_CONDITION_CATALOG : PRESET_CATALOG;

  const filtered = catalogToUse.filter((c) => {
    return (activeTab === 'presets' || category === 'all' || c.category === category)
      && (!search.trim() || `${c.label} ${c.description}`.toLowerCase().includes(search.trim().toLowerCase()));
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
      <button aria-pressed={activeTab === 'presets'} onClick={() => {setActiveTab('presets'); setSearch('');}}><Library className="inline mr-2" size={14} />Pre-built Scans</button>
      <div className="match-mode" role="group" aria-label="Match mode"><span>Match</span><button aria-pressed={localMode === 'all'} onClick={() => setLocalMode('all')}>AND (All)</button><button aria-pressed={localMode === 'any'} onClick={() => setLocalMode('any')}>OR (Any)</button></div>
    </div>
    <div className="filter-modal-options">
      <label className="query-input"><input aria-label="Search filters" placeholder="Search filters" value={search} onChange={event => setSearch(event.target.value)} /></label>
      {activeTab === 'custom' && <div className="filter-categories" role="group" aria-label="Filter categories">{CATEGORY_TABS.map(tab => <button key={tab.id} aria-pressed={category === tab.id} onClick={() => setCategory(tab.id)}>{tab.label}</button>)}</div>}
    </div>
    <div className="filter-modal-content">
      <UnavailableConditions conditions={localMap} onRemove={key => setLocalMap(current => {
        const next = {...current};
        delete next[key];
        return next;
      })} />
      <div className="grid grid-cols-1 gap-x-8 xl:grid-cols-2" data-preset-list={activeTab === 'presets'}>
        {filtered.map(def => <FilterRow key={def.id} def={def} active={localMap[def.id]} showParameters={activeTab === 'custom'} toggle={toggle} updateParam={updateParam} />)}
      </div>
      {!filtered.length && <div className="data-state"><h2>No matching {activeTab === 'custom' ? 'filters' : 'scans'}</h2><p>Try a different category or search.</p></div>}
    </div>
    {validationError && !hasUnavailableConditions(localMap) && <p role="alert" className="px-6 py-2 text-sm text-red-600">{validationError}</p>}
    <div className="dialog-footer"><span className="cell-muted text-xs">{Object.keys(localMap).length} selected</span>
      <div className="flex gap-2"><button onClick={handleReset} className="button button-secondary">Reset</button><button onClick={handleApply} disabled={Boolean(validationError)} className="button button-primary">Apply</button></div>
    </div>
  </Dialog>;
};
