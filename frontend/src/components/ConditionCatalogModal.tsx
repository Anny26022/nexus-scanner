import React, { useState } from 'react';
import { X, Search, Sliders, RotateCcw, Check, Play, Info } from 'lucide-react';
import { ConditionDef, ConditionCategory, ActiveCondition, MatchMode } from '../types/screener';
import { NEXUS_CONDITION_CATALOG } from '../data/conditionCatalog';
import { breadthMetricDefault } from '../data/breadthMetricDefaults';

interface ConditionCatalogModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeConditionsMap: Record<string, ActiveCondition>;
  matchMode: MatchMode;
  onApplyConditions: (
    updatedMap: Record<string, ActiveCondition>,
    updatedMatchMode: MatchMode
  ) => void;
}

const CATEGORY_TABS: Array<{ id: ConditionCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All Indicators' },
  { id: 'trend', label: 'Technicals' },
  { id: 'momentum', label: 'Momentum & Volume' },
  { id: 'range', label: 'Range & Patterns' },
  { id: 'relative_strength', label: 'Relative Strength' },
  { id: 'fundamentals', label: 'Fundamentals' },
  { id: 'liquidity', label: 'Liquidity' },
];

export const ConditionCatalogModal: React.FC<ConditionCatalogModalProps> = ({
  isOpen,
  onClose,
  activeConditionsMap,
  matchMode,
  onApplyConditions,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ConditionCategory | 'all'>('all');
  const [localConditionsMap, setLocalConditionsMap] = useState<Record<string, ActiveCondition>>(
    activeConditionsMap
  );
  const [localMatchMode, setLocalMatchMode] = useState<MatchMode>(matchMode);

  if (!isOpen) return null;

  const filteredConditions = NEXUS_CONDITION_CATALOG.filter((cond) => {
    const matchesCategory = selectedCategory === 'all' || cond.category === selectedCategory;
    const matchesSearch =
      cond.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cond.description.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const handleToggleCondition = (def: ConditionDef) => {
    setLocalConditionsMap((prev) => {
      const next = { ...prev };
      if (next[def.id]) {
        delete next[def.id];
      } else {
        const defaultParams: Record<string, any> = {};
        def.parameters.forEach((p) => {
          defaultParams[p.id] = p.defaultValue;
        });
        next[def.id] = {
          instanceId: `cond_${def.id}_${Date.now()}`,
          conditionId: def.id,
          parameters: defaultParams,
        };
      }
      return next;
    });
  };

  const handleUpdateParameter = (conditionId: string, paramId: string, value: any) => {
    setLocalConditionsMap((prev) => {
      const def = NEXUS_CONDITION_CATALOG.find((c) => c.id === conditionId);
      const existing = prev[conditionId];
      if (!existing && def) {
        const defaultParams: Record<string, any> = {};
        def.parameters.forEach((p) => {
          defaultParams[p.id] = p.defaultValue;
        });
        defaultParams[paramId] = value;
        if (conditionId === 'MARKET_BREADTH' && paramId === 'metric') {
          defaultParams.value = breadthMetricDefault(value);
        }
        return {
          ...prev,
          [conditionId]: {
            instanceId: `cond_${conditionId}_${Date.now()}`,
            conditionId,
            parameters: defaultParams,
          },
        };
      }
      if (!existing) return prev;
      const parameters = { ...existing.parameters, [paramId]: value };
      if (conditionId === 'MARKET_BREADTH' && paramId === 'metric') {
        parameters.value = breadthMetricDefault(value);
      }
      return {
        ...prev,
        [conditionId]: {
          ...existing,
          parameters,
        },
      };
    });
  };

  const handleResetLocal = () => {
    setLocalConditionsMap({});
  };

  const handleApply = () => {
    onApplyConditions(localConditionsMap, localMatchMode);
    onClose();
  };

  const activeCount = Object.keys(localConditionsMap).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-900/40 backdrop-blur-xs animate-fade-in">
      <div className="bg-white border border-slate-200/90 rounded-2xl w-full max-w-4xl lg:max-w-5xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Normal Standard Header Bar with Title & Close (X) Button */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-white">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-slate-100 text-slate-700 border border-slate-200/60">
              <Sliders className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 tracking-tight">
                Screener Dialogue & Criteria Catalog
              </h3>
              <p className="text-[11px] text-slate-500">
                Select indicators and set quantitative parameter limits
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            title="Close Screener Dialogue"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Category Tabs & Search Bar */}
        <div className="p-4 px-6 border-b border-slate-100 bg-slate-50/50 space-y-3">
          {/* Category Tabs Row */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
            {CATEGORY_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setSelectedCategory(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                  selectedCategory === tab.id
                    ? 'bg-slate-900 text-white font-semibold shadow-2xs'
                    : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200/80'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Search Input & Match Mode Toggle */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search indicator filters (e.g. RVOL, SMA 50, RS Rating, ROE)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-400"
              />
            </div>

            <div className="flex items-center p-0.5 rounded-lg bg-slate-100 border border-slate-200 text-xs shrink-0">
              <button
                onClick={() => setLocalMatchMode('all')}
                className={`px-3 py-1 rounded font-semibold text-[11px] transition-all cursor-pointer ${
                  localMatchMode === 'all'
                    ? 'bg-white text-slate-900 shadow-2xs border border-slate-200'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Match ALL (AND)
              </button>
              <button
                onClick={() => setLocalMatchMode('any')}
                className={`px-3 py-1 rounded font-semibold text-[11px] transition-all cursor-pointer ${
                  localMatchMode === 'any'
                    ? 'bg-white text-slate-900 shadow-2xs border border-slate-200'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Match ANY (OR)
              </button>
            </div>
          </div>
        </div>

        {/* 2-Column Visual Filter Grid */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 bg-white">
          {filteredConditions.length === 0 ? (
            <div className="text-center py-12">
              <Info className="h-6 w-6 text-slate-400 mx-auto mb-2" />
              <p className="text-xs font-semibold text-slate-700">No matching criteria found</p>
              <p className="text-[11px] text-slate-400">Try adjusting your search query or category tab</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {filteredConditions.map((def) => {
                const activeCond = localConditionsMap[def.id];
                const isChecked = !!activeCond;

                return (
                  <div
                    key={def.id}
                    className={`p-3.5 rounded-xl border transition-all space-y-2.5 ${
                      isChecked
                        ? 'bg-emerald-50/40 border-emerald-300 shadow-2xs'
                        : 'bg-white border-slate-200/90 hover:border-slate-300'
                    }`}
                  >
                    {/* Header Row: Checkbox, Title & Category Badge */}
                    <div className="flex items-start justify-between gap-2">
                      <label
                        onClick={() => handleToggleCondition(def)}
                        className="flex items-center space-x-2.5 cursor-pointer select-none"
                      >
                        <div
                          className={`h-4 w-4 rounded flex items-center justify-center border transition-all ${
                            isChecked
                              ? 'bg-emerald-600 border-emerald-600 text-white'
                              : 'bg-white border-slate-300 hover:border-slate-400'
                          }`}
                        >
                          {isChecked && <Check className="h-3 w-3 stroke-[3]" />}
                        </div>
                        <span
                          className={`text-xs font-bold ${
                            isChecked ? 'text-slate-900' : 'text-slate-800'
                          }`}
                        >
                          {def.label}
                        </span>
                      </label>

                      <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200/70">
                        {def.category}
                      </span>
                    </div>

                    {/* Description Subtitle */}
                    <p className="text-[11px] text-slate-500 pl-6.5 leading-normal">
                      {def.description}
                    </p>

                    {/* Inline Parameter Controls Grid */}
                    <div className="pl-6.5 grid grid-cols-2 gap-2 text-xs">
                      {def.parameters.map((p) => {
                        const currentValue = isChecked
                          ? activeCond.parameters[p.id]
                          : p.defaultValue;

                        return (
                          <div key={p.id} className="space-y-0.5">
                            <label className="text-[10px] font-medium text-slate-500 block truncate">
                              {p.label}
                            </label>
                            {p.type === 'select' ? (
                              <select
                                value={currentValue}
                                onChange={(e) =>
                                  handleUpdateParameter(def.id, p.id, e.target.value)
                                }
                                className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-900 focus:outline-none focus:border-slate-400 cursor-pointer"
                              >
                                {(p.options || []).map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="number"
                                value={currentValue}
                                onChange={(e) =>
                                  handleUpdateParameter(
                                    def.id,
                                    p.id,
                                    parseFloat(e.target.value) || 0
                                  )
                                }
                                min={p.min}
                                max={p.max}
                                step={p.step || 0.1}
                                className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono text-slate-900 focus:outline-none focus:border-slate-400"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Sticky Bottom Footer Bar */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-100 bg-slate-50/50">
          <button
            onClick={handleResetLocal}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100 text-xs font-semibold transition-colors cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset Filters</span>
          </button>

          <div className="flex items-center space-x-3">
            <span className="text-xs font-medium text-slate-500 hidden sm:inline">
              <strong className="text-slate-900 font-bold">{activeCount}</strong> filter
              {activeCount === 1 ? '' : 's'} selected
            </span>
            <button
              onClick={handleApply}
              className="flex items-center space-x-2 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs shadow-2xs transition-all cursor-pointer"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>Apply Filters & Run Screen</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
