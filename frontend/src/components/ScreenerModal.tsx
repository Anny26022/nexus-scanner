import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, SlidersHorizontal, Library } from 'lucide-react';
import { ConditionCategory, ActiveCondition, MatchMode, ConditionDef, ParameterSpec } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { PRESET_CATALOG } from '../data/presetCatalog';

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

const MultiSelectDropdown = ({ options, value, onChange }: any) => {
  const [isOpen, setIsOpen] = useState(false);

  const toggle = (val: string) => {
    const arr = value || [];
    if (arr.includes(val)) {
      onChange(arr.filter((v: string) => v !== val));
    } else {
      onChange([...arr, val]);
    }
  };
  
  return (
    <div className="relative">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="bg-white border border-gray-200 hover:border-teal-400 rounded-md px-1.5 py-0.5 text-[11px] text-gray-700 focus:outline-none max-w-[120px] shrink-0 truncate transition-colors cursor-pointer flex items-center gap-1"
      >
        <span className="truncate">{value?.length ? `${value.length} selected` : 'Select...'}</span>
        <svg className="w-2.5 h-2.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
      </button>
      
      {isOpen && (
        <>
          <div className="fixed inset-0 z-[120]" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-[121] bg-white rounded-md shadow-lg py-0.5 border border-gray-200 min-w-[140px] text-[11px]">
             {options.map((o: any) => {
               const selected = value?.includes(o.value);
               return (
                 <div
                   key={o.value}
                   onClick={() => toggle(o.value)}
                   className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors ${selected ? 'bg-teal-50 text-teal-800' : 'text-gray-700 hover:bg-gray-50'}`}
                 >
                   <input type="checkbox" checked={selected} readOnly className="w-3 h-3 rounded border-gray-300 text-teal-600 pointer-events-none" />
                   <span className="truncate font-medium">{o.label}</span>
                 </div>
               );
             })}
          </div>
        </>
      )}
    </div>
  );
};

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
  const [activeTab, setActiveTab] = useState<'custom' | 'presets'>('custom');

  if (!isOpen) return null;

  const catalogToUse = activeTab === 'custom' ? NEXUS_CONDITION_CATALOG : PRESET_CATALOG;

  const filtered = catalogToUse.filter((c) => {
    return activeTab === 'presets' || category === 'all' || c.category === category;
  });

  const toggle = (def: ConditionDef) => {
    setLocalMap((prev) => {
      if (prev[def.id]) {
        const next = { ...prev };
        delete next[def.id];
        return next;
      }
      const params: Record<string, any> = {};
      def.parameters?.forEach((p) => (params[p.id] = p.defaultValue));
      return {
        ...prev,
        [def.id]: { instanceId: `${def.id}_${Date.now()}`, conditionId: def.id, parameters: params },
      };
    });
  };

  const updateParam = (condId: string, paramId: string, value: any) => {
    setLocalMap((prev) => {
      const def = NEXUS_CONDITION_CATALOG.find((c) => c.id === condId) ?? PRESET_CATALOG.find(c=>c.id===condId);
      const existing = prev[condId];
      if (!existing && def) {
        const params: Record<string, any> = {};
        def.parameters.forEach((p) => (params[p.id] = p.defaultValue));
        params[paramId] = value;
        return {
          ...prev,
          [condId]: { instanceId: `${condId}_${Date.now()}`, conditionId: condId, parameters: params },
        };
      }
      if (!existing) return prev;
      return {
        ...prev,
        [condId]: { ...existing, parameters: { ...existing.parameters, [paramId]: value } },
      };
    });
  };

  const handleReset = () => setLocalMap({});

  const handleApply = () => {
    // MA convergence is the only structured list entered as text. Preserve a
    // safe default instead of sending a malformed list to the evaluator.
    const validated = Object.fromEntries(Object.entries(localMap).map(([id, condition]) => {
      if (condition.conditionId !== 'MA_CONVERGENCE') return [id, condition];
      const values = String(condition.parameters.periods ?? '').split(',').map(value => value.trim());
      const valid = values.length >= 2 && values.every(value => /^\d+$/.test(value) && Number(value) > 0)
        && new Set(values).size === values.length;
      return [id, valid ? condition : {
        ...condition, parameters: { ...condition.parameters, periods: '9,20,50,200' },
      }];
    }));
    onApply(validated, localMode);
    onClose();
  };

  // The row title and each control's accessible label provide the context;
  // keeping the inputs compact makes dense filter groups easier to scan.
  const renderInput = (defId: string, p: ParameterSpec, checked: boolean) => {
    const val = checked && localMap[defId] ? localMap[defId].parameters[p.id] : p.defaultValue;
    let control: React.ReactNode;
    if (p.type === 'boolean') {
      control = <input aria-label={p.label} type="checkbox" checked={!!val}
        onChange={e => updateParam(defId, p.id, e.target.checked)} />;
    } else if (p.type === 'string') {
      control = <input aria-label={p.label} value={val ?? ''}
        onChange={e => updateParam(defId, p.id, e.target.value)}
        className="w-24 bg-white border border-gray-200 rounded-md px-1.5 py-0.5 text-[11px]" />;
    } else if (p.type === 'multiselect') {
      control = <MultiSelectDropdown options={p.options || []} value={val}
        onChange={(newVal: string[]) => updateParam(defId, p.id, newVal)} />;
    } else if (p.type === 'select') {
      control = <select
          value={val}
          onChange={(e) => updateParam(defId, p.id, e.target.value)}
          className="bg-white border border-gray-200 hover:border-teal-400 rounded-md px-1.5 py-0.5 text-[11px] text-gray-700 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 max-w-[110px] shrink-0 truncate transition-colors cursor-pointer"
        >
          {(p.options || []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>;
    } else {
      control = <input
        type="number"
        value={val}
        onChange={(e) => updateParam(defId, p.id, parseFloat(e.target.value) || 0)}
        min={p.min}
        max={p.max}
        step={p.step ?? 0.1}
        aria-label={p.label}
        className="w-14 bg-white border border-gray-200 hover:border-teal-400 rounded-md px-1.5 py-0.5 text-[11px] text-gray-700 text-center focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 transition-colors"
      />;
    }

    return (
      <div key={p.id} title={p.description ?? p.label} className="flex items-center shrink-0">
        {control}
        {p.unit && <span className="ml-1 text-[10px] text-gray-400 whitespace-nowrap">{readableUnit(p.unit)}</span>}
      </div>
    );
  };

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[100] bg-gray-900/60 backdrop-blur-sm transition-opacity"
      />

      {/* Modal Panel Container */}
      <div className="fixed inset-0 z-[101] flex items-center justify-center p-4 sm:p-6" onClick={onClose}>
        <div
          className="bg-white rounded-xl shadow-2xl flex flex-col w-full max-w-7xl overflow-hidden border border-gray-200"
          style={{ maxHeight: '90vh' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Top Control Bar ── */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-white">
            {/* Left: Mode Toggle */}
            <div className="flex bg-gray-100 p-0.5 rounded-lg border border-gray-200">
              <button
                onClick={() => setActiveTab('custom')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${
                  activeTab === 'custom' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <SlidersHorizontal className="w-3 h-3" />
                Custom Filters
              </button>
              <button
                onClick={() => setActiveTab('presets')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${
                  activeTab === 'presets' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Library className="w-3 h-3" />
                Pre-built Scans
              </button>
            </div>

            {/* Right: Close */}
            <div className="flex items-center">
              <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-md text-gray-400 hover:text-gray-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* ── Categories & Match Mode ── */}
          {activeTab === 'custom' && (
            <div className="px-5 py-2.5 flex items-center justify-between border-b border-gray-100 bg-[#f8fcfb]">
              {/* Compact condition categories */}
              <div className="flex flex-wrap items-center rounded-md border border-teal-600 overflow-hidden bg-white shadow-sm">
                {CATEGORY_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setCategory(tab.id)}
                    className={`px-4 py-1 text-[11px] font-semibold transition-colors ${
                      category === tab.id
                        ? 'bg-teal-600 text-white'
                        : 'text-gray-600 hover:bg-teal-50 hover:text-teal-700'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Match Mode (AND/OR) */}
              <div className="flex items-center gap-2 text-[11px] font-semibold text-gray-500">
                Match:
                <div className="flex bg-gray-200 rounded border border-gray-300 p-0.5 overflow-hidden">
                  <button
                    onClick={() => setLocalMode('all')}
                    className={`px-3 py-0.5 transition-colors ${localMode === 'all' ? 'bg-white text-gray-900 rounded-sm shadow-sm' : 'hover:text-gray-900'}`}
                  >
                    AND (All)
                  </button>
                  <button
                    onClick={() => setLocalMode('any')}
                    className={`px-3 py-0.5 transition-colors ${localMode === 'any' ? 'bg-white text-gray-900 rounded-sm shadow-sm' : 'hover:text-gray-900'}`}
                  >
                    OR (Any)
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-5 bg-white overflow-x-hidden">
            <div className={`grid gap-x-8 gap-y-1 ${activeTab === 'presets' ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3' : 'grid-cols-1 xl:grid-cols-2'}`}>
              {filtered.map((def) => {
                const active = localMap[def.id];
                const checked = !!active;

                return (
                  <div key={def.id} className="grid grid-cols-[minmax(10rem,1fr)_minmax(0,auto)] items-start gap-x-3 py-2 border-b border-gray-50 last:border-0 hover:bg-gray-50/50 px-2 -mx-2 rounded transition-colors group">
                    <label className="flex items-center gap-2.5 cursor-pointer min-w-0 pt-1">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(def)}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-teal-600 focus:ring-teal-500 transition-all cursor-pointer flex-shrink-0"
                      />
                      <span title={def.description} className={`text-[12px] font-semibold truncate ${checked ? 'text-gray-900' : 'text-gray-600 group-hover:text-gray-800'}`}>
                        {def.label}:
                      </span>
                    </label>

                    {/* Inputs keep their own compact groups and wrap inside this row when needed. */}
                    {(activeTab === 'custom' || checked) && def.parameters && def.parameters.length > 0 && (
                      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                        {def.parameters.map((p) => renderInput(def.id, p, checked))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            
            {filtered.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <p className="text-sm font-semibold text-gray-500">No {activeTab === 'custom' ? 'filters' : 'scans'} in this category</p>
                <p className="text-xs text-gray-400 mt-1">Try selecting a different tab</p>
              </div>
            )}
          </div>

          {/* ── Footer ── */}
          <div className="flex items-center justify-center gap-6 px-6 py-4 border-t border-gray-100 bg-white">
            <button
              onClick={handleReset}
              className="px-8 py-2 rounded-full border border-gray-300 text-gray-700 hover:bg-gray-50 text-[12px] font-bold transition-colors shadow-sm"
            >
              Reset
            </button>
            <button
              onClick={handleApply}
              className="px-8 py-2 rounded-full bg-teal-600 hover:bg-teal-700 text-white text-[12px] font-bold transition-colors shadow-sm"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
};
