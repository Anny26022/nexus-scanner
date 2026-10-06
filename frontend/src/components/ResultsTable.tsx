import React, { useState,useRef } from 'react';
import { ScreenerRunResponse } from '../types/screener';
import {
  ArrowUpDown,
  Copy,
  Check,
  PlusCircle,
  AlertTriangle,
  FileQuestion,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import type { SelectedBases,BaseRecord } from '../engine/baseConditions';
import { BaseChartDialog } from './BaseChart';
import { SymbolWithLogo } from './SymbolWithLogo';

interface ResultsTableProps {
  data?: ScreenerRunResponse;
  baseStages?: Array<keyof SelectedBases>;
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
  onPageChange: (page: number) => void;
  onSortChange: (field: string, direction: 'asc' | 'desc') => void;
  currentSort?: { field: string; direction: 'asc' | 'desc' };
  onAddToWatchlist?: (symbols: string[]) => void;
}

export const ResultsTable: React.FC<ResultsTableProps> = ({
  data,
  baseStages=[],
  isLoading,
  isError,
  error,
  onPageChange,
  onSortChange,
  currentSort,
  onAddToWatchlist,
}) => {
  const [copiedTv, setCopiedTv] = useState(false);
  const [chartSymbol,setChartSymbol]=useState<string|null>(null);
  const [stageChoice,setStageChoice]=useState<keyof SelectedBases|undefined>();
  const stage=stageChoice&&baseStages.includes(stageChoice)?stageChoice:baseStages[0];
  const chartTrigger=useRef<HTMLButtonElement|null>(null);

  if (isLoading) {
    return (
      <div className="bg-white border border-slate-200/90 rounded-2xl p-8 text-center space-y-3 shadow-2xs">
        <div className="inline-block animate-spin rounded-full h-6 w-6 border-2 border-slate-900 border-t-transparent"></div>
        <p className="text-xs font-medium text-slate-600">Evaluating screener expression across NSE mainboard universe...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="bg-rose-50 border border-rose-200 rounded-2xl p-6 text-center space-y-2">
        <AlertTriangle className="h-7 w-7 text-rose-600 mx-auto" />
        <h4 className="text-sm font-semibold text-rose-900">Screener Query Failed</h4>
        <p className="text-xs text-rose-700 max-w-md mx-auto font-mono">
          {error?.message || 'An unexpected error occurred while executing the query.'}
        </p>
      </div>
    );
  }

  if (!data) return null;

  const handleCopyTradingView = () => {
    const tvList = data.rows.map((r) => `NSE:${r.symbol}`).join(', ');
    navigator.clipboard.writeText(tvList);
    setCopiedTv(true);
    setTimeout(() => setCopiedTv(false), 2000);
  };

  const handleSortClick = (field: string) => {
    const nextDir = currentSort?.field === field && currentSort.direction === 'asc' ? 'desc' : 'asc';
    onSortChange(field, nextDir);
  };

  const totalPages = Math.ceil(data.matchCount / data.pageSize);

  return (
    <div className="space-y-3">
      {/* Crisp Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200/90 px-4 py-3 rounded-2xl shadow-2xs">
        <div className="flex items-center space-x-3">
          <div className="text-xs">
            <span className="text-slate-500 font-medium">Matched Equities: </span>
            <strong className="text-slate-900 font-mono text-sm">{data.matchCount}</strong>
            <span className="text-slate-400 text-[11px] ml-1">/ {data.totalUniverseCount} Universe</span>
          </div>

        </div>

        {/* Toolbar Actions */}
        <div className="flex items-center space-x-2">
          <button
            onClick={handleCopyTradingView}
            disabled={data.rows.length === 0}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium border border-slate-200 transition-colors disabled:opacity-40 cursor-pointer shadow-2xs"
          >
            {copiedTv ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-slate-500" />}
            <span>{copiedTv ? 'Copied!' : 'Copy TradingView'}</span>
          </button>

          {onAddToWatchlist && (
            <button
              onClick={() => onAddToWatchlist(data.rows.map((r) => r.symbol))}
              disabled={data.rows.length === 0}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium border border-slate-200 transition-colors disabled:opacity-40 cursor-pointer shadow-2xs"
            >
              <PlusCircle className="h-3.5 w-3.5 text-emerald-600" />
              <span>Watchlist</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Results Table */}
      <div className="flex max-h-[calc(100svh-9rem)] min-h-[24rem] flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xs">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-xs text-slate-800">
            <thead className="sticky top-0 z-10 bg-slate-50/95 text-slate-500 uppercase text-[10px] tracking-wider border-b border-slate-200/90 backdrop-blur-sm">
              <tr>
                <th className="py-3 px-4 font-semibold">Symbol & Name</th>
                {stage&&<th className="py-3 px-4 font-semibold">Base setup{baseStages.length>1&&<select aria-label="Displayed base stage" value={stage} onChange={event=>setStageChoice(event.target.value as keyof SelectedBases)} className="ml-2 rounded border border-slate-200 px-1 py-0.5 text-[10px]">{baseStages.map(value=><option key={value} value={value}>{value.replaceAll('_',' ').toLowerCase()}</option>)}</select>}</th>}
                <th className="py-3 px-4 font-semibold">Sector / Industry</th>
                <th
                  onClick={() => handleSortClick('close')}
                  className="py-3 px-4 font-semibold cursor-pointer hover:text-slate-900 transition-colors"
                >
                  <div className="flex items-center space-x-1">
                    <span>Close Price</span>
                    <ArrowUpDown className="h-3 w-3" />
                  </div>
                </th>
                <th
                  onClick={() => handleSortClick('changePct')}
                  className="py-3 px-4 font-semibold cursor-pointer hover:text-slate-900 transition-colors"
                >
                  <div className="flex items-center space-x-1">
                    <span>1D Return</span>
                    <ArrowUpDown className="h-3 w-3" />
                  </div>
                </th>
                <th
                  onClick={() => handleSortClick('rvol')}
                  className="py-3 px-4 font-semibold cursor-pointer hover:text-slate-900 transition-colors"
                >
                  <div className="flex items-center space-x-1">
                    <span>20D RVOL</span>
                    <ArrowUpDown className="h-3 w-3" />
                  </div>
                </th>
                <th
                  onClick={() => handleSortClick('marketCapCrore')}
                  className="py-3 px-4 font-semibold cursor-pointer hover:text-slate-900 transition-colors"
                >
                  <div className="flex items-center space-x-1">
                    <span>Market Cap (Cr)</span>
                    <ArrowUpDown className="h-3 w-3" />
                  </div>
                </th>
                <th className="py-3 px-4 font-semibold">RS & RSI</th>
                <th className="py-3 px-4 font-semibold">Delivery %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={stage?9:8} className="py-10 text-center text-slate-500 font-sans">
                    <FileQuestion className="h-7 w-7 text-slate-400 mx-auto mb-2" />
                    <p className="text-xs font-semibold text-slate-700">No Equities Matched Screener Criteria</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Try adjusting threshold parameters or choosing a broader universe
                    </p>
                  </td>
                </tr>
              ) : (
                data.rows.map((row) => (
                  <tr key={row.symbol} className="hover:bg-slate-50/70 transition-colors">
                    {/* Symbol & Name */}
                    <td className="py-3.5 px-4 font-sans">
                      <div className="flex items-center gap-1.5">
                        <button onClick={event=>{chartTrigger.current=event.currentTarget;setChartSymbol(row.symbol);}} aria-label={`Open ${row.symbol} chart`} className="rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-teal-600"><SymbolWithLogo symbol={row.symbol} name={row.name} /></button>
                        {row.isFno && (
                          <span className="text-[9px] font-semibold px-1 py-0.2 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                            F&O
                          </span>
                        )}
                      </div>
                    </td>

                    {stage&&<td className="py-3.5 px-4 text-[11px] text-slate-600"><BaseExplanation record={Object.values(row.setupMatches??{}).find(record=>record.stage===stage)??row.bases?.[stage]}/></td>}
                    {/* Sector & Industry */}
                    <td className="py-3.5 px-4 font-sans">
                      <div
                        className={`text-xs ${
                          row.sector === 'Unclassified'
                            ? 'italic text-slate-400 font-normal'
                            : 'font-medium text-slate-700'
                        }`}
                      >
                        {row.sector}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate max-w-[140px]">{row.industry}</div>
                    </td>

                    {/* Close */}
                    <td className="py-3.5 px-4 font-semibold text-slate-900">
                      ₹{row.close.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>

                    {/* 1D Return */}
                    <td className="py-3.5 px-4 font-semibold">
                      <div
                        className={`flex items-center space-x-1 ${
                          row.changePct >= 0 ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        {row.changePct >= 0 ? (
                          <TrendingUp className="h-3.5 w-3.5" />
                        ) : (
                          <TrendingDown className="h-3.5 w-3.5" />
                        )}
                        <span>{row.changePct == null ? 'N/A' : `${row.changePct >= 0 ? '+' : ''}${row.changePct.toFixed(2)}%`}</span>
                      </div>
                    </td>

                    {/* RVOL */}
                    <td className="py-3.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                          row.rvol != null && row.rvol >= 2.0
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : row.rvol != null && row.rvol >= 1.2
                            ? 'bg-blue-50 text-blue-700 border border-blue-200'
                            : 'text-slate-600'
                        }`}
                      >
                        {row.rvol == null ? 'N/A' : `${row.rvol.toFixed(2)}x`}
                      </span>
                    </td>

                    {/* Market Cap */}
                    <td className="py-3.5 px-4 text-slate-700">
                      {row.marketCapCrore == null ? 'N/A' : `₹${Math.round(row.marketCapCrore).toLocaleString('en-IN')} Cr`}
                    </td>

                    {/* Technicals */}
                    <td className="py-3.5 px-4 font-sans text-xs space-y-0.5">
                      <div className="flex items-center space-x-1.5">
                        <span className="text-slate-400 text-[10px]">RS:</span>
                        <span className="font-mono font-bold text-slate-900 text-xs">{row.rsRating ?? 'N/A'}</span>
                      </div>
                      <div className="text-[10px] text-slate-400">
                        RSI: <span className="text-slate-700 font-mono">{row.rsi14 ?? 'N/A'}</span>
                      </div>
                    </td>

                    {/* Delivery % */}
                    <td className="py-3.5 px-4 font-mono">
                      {row.deliveryPct === null ? (
                        <span className="text-[10px] italic text-slate-400 font-sans">Unavailable</span>
                      ) : (
                        <span className="font-semibold text-slate-700">{row.deliveryPct}%</span>
                      )}
                    </td>

                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="sticky bottom-0 z-20 flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 text-xs shadow-[0_-6px_16px_rgba(15,23,42,0.05)] backdrop-blur-sm">
            <span className="text-slate-500">
              {((data.page - 1) * data.pageSize + 1).toLocaleString('en-IN')}–{Math.min(data.page * data.pageSize, data.matchCount).toLocaleString('en-IN')} of {data.matchCount.toLocaleString('en-IN')}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => onPageChange(data.page - 1)}
                disabled={data.page === 1}
                className="rounded-md border border-slate-200 px-2.5 py-1.5 font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="px-1 py-1.5 text-slate-400">{data.page} / {totalPages}</span>
              <button
                onClick={() => onPageChange(data.page + 1)}
                disabled={data.page >= totalPages}
                className="rounded-md border border-slate-200 px-2.5 py-1.5 font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      {chartSymbol&&<BaseChartDialog key={`${data.immutableRevision}:${chartSymbol}`} symbol={chartSymbol} revision={data.immutableRevision} initialStage={stage} onClose={()=>{setChartSymbol(null);chartTrigger.current?.focus();}}/>}
    </div>
  );
};

function BaseExplanation({record}:{record?:BaseRecord}){
  if(!record)return <span>—</span>;
  const base=(record.base??{}) as BaseRecord,context=(record.stage==='FORMING'?record.current:record.selection) as BaseRecord|undefined;
  const format=(value:unknown,suffix='')=>typeof value==='number'&&Number.isFinite(value)?`${value.toFixed(2)}${suffix}`:'—';
  return <div className="min-w-48"><span className="block font-medium text-slate-700">RS {format(context?.rsRating)} · Depth {format(base.depthPct,'%')}</span><span className="block text-slate-500">ATR {format(base.atrContraction,'×')} · Volume {format(base.volumeDryUp,'×')} · Pivot {format(record.distanceFromPivotPct,'%')}</span></div>;
}
