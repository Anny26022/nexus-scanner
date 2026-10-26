import React, { useState, useEffect, useMemo } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { portalContainer } from '../embedding';

export interface SessionMeta {
  date: string;
  label?: string;
  isHistorical: boolean;
  revision: string;
}

interface SessionDatePickerProps {
  selectedDate: string;
  latestDate: string;
  availableSessions: SessionMeta[];
  onChange: (date: string | null) => void;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const SessionDatePicker: React.FC<SessionDatePickerProps> = ({
  selectedDate,
  latestDate,
  availableSessions,
  onChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // Set of dates that have actual snapshots
  const availableSet = useMemo(() => new Set(availableSessions.map((s) => s.date)), [availableSessions]);

  // Determine active view year/month (default to selected date, or latest)
  const initialDate = selectedDate || latestDate || '2026-10-16';
  const [viewYear, setViewYear] = useState(() => parseInt(initialDate.slice(0, 4), 10) || 2026);
  const [viewMonth, setViewMonth] = useState(() => (parseInt(initialDate.slice(5, 7), 10) || 10) - 1);

  // Sync view when selectedDate changes externally
  useEffect(() => {
    if (selectedDate) {
      const y = parseInt(selectedDate.slice(0, 4), 10);
      const m = parseInt(selectedDate.slice(5, 7), 10) - 1;
      if (!isNaN(y)) setViewYear(y);
      if (!isNaN(m)) setViewMonth(m);
    }
  }, [selectedDate]);

  // Year range from availableSessions (or 2021 to 2026)
  const availableYears = useMemo(() => {
    const years = new Set<number>();
    for (const s of availableSessions) {
      const y = parseInt(s.date.slice(0, 4), 10);
      if (!isNaN(y)) years.add(y);
    }
    return years.size === 0 ? [2021, 2022, 2023, 2024, 2025, 2026] : Array.from(years).sort((a, b) => a - b);
  }, [availableSessions]);

  // Earliest session archive begins Oct 2021 (month index 9)
  const isAtMin = viewYear <= 2021 && viewMonth <= 9;

  const handlePrevMonth = () => {
    if (isAtMin) return;
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  // Calendar days calculation
  const calendarDays = useMemo(() => {
    const firstDayIndex = new Date(viewYear, viewMonth, 1).getDay(); // 0 = Sun
    const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
    const days: Array<{ day: number; dateStr: string; isAvailable: boolean } | null> = [];

    for (let i = 0; i < firstDayIndex; i++) days.push(null);

    for (let d = 1; d <= totalDays; d++) {
      const mm = String(viewMonth + 1).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      const dateStr = `${viewYear}-${mm}-${dd}`;
      days.push({
        day: d,
        dateStr,
        isAvailable: availableSet.has(dateStr),
      });
    }

    return days;
  }, [viewYear, viewMonth, availableSet]);

  const isHistorical = Boolean(selectedDate && latestDate && selectedDate !== latestDate);

  const formattedSelected = useMemo(() => {
    const d = selectedDate || latestDate;
    if (!d) return 'Select Date';
    try {
      return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return d;
    }
  }, [selectedDate, latestDate]);

  return (
    <div className="relative inline-flex items-center gap-2">
      <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`h-[26px] px-2.5 rounded-md border text-xs font-medium inline-flex items-center gap-2 transition-all cursor-pointer ${
              isHistorical
                ? 'border-amber-500/50 bg-amber-500/10 text-amber-500 font-semibold hover:border-amber-500'
                : 'border-line bg-surface hover:bg-surface-hover hover:border-line-strong text-text'
            }`}
            title="Click to select trading session"
            aria-label="Select trading session"
          >
            <CalendarDays size={13} className={isHistorical ? 'text-amber-500' : 'text-muted'} />
            <span>{formattedSelected}</span>
            {!isHistorical && <span className="text-[10px] text-muted font-normal">(Latest)</span>}
            <ChevronDown size={12} className={`text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </button>
        </Popover.Trigger>

        {isHistorical && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="h-[26px] px-2 rounded-md text-[11px] font-medium text-muted hover:text-text hover:bg-surface-hover transition-colors inline-flex items-center gap-1 cursor-pointer"
            title="Reset to latest trading session"
          >
            <RotateCcw size={11} />
            <span>Reset</span>
          </button>
        )}

        <Popover.Portal container={portalContainer()}>
          <Popover.Content
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className="z-50 w-[260px] p-2.5 rounded-lg border border-line bg-surface shadow-2xl animate-in fade-in zoom-in-95 duration-100 outline-none"
          >
            {/* Month & Year Controls */}
            <div className="flex items-center justify-between gap-1 mb-2">
              <button
                type="button"
                onClick={handlePrevMonth}
                disabled={isAtMin}
                className={`p-1 rounded transition-colors ${
                  isAtMin
                    ? 'text-muted/30 cursor-not-allowed'
                    : 'text-muted hover:text-text hover:bg-surface-hover cursor-pointer'
                }`}
                aria-label="Previous month"
              >
                <ChevronLeft size={14} />
              </button>

              <div className="flex items-center gap-1">
                <select
                  value={viewMonth}
                  onChange={(e) => setViewMonth(Number(e.target.value))}
                  className="h-6 px-1 text-xs font-medium border border-line rounded bg-surface text-text cursor-pointer outline-none hover:border-line-strong"
                  aria-label="Select month"
                >
                  {MONTH_NAMES.map((name, idx) => (
                    <option key={name} value={idx} disabled={viewYear === 2021 && idx < 9}>
                      {name}
                    </option>
                  ))}
                </select>

                <select
                  value={viewYear}
                  onChange={(e) => {
                    const y = Number(e.target.value);
                    setViewYear(y);
                    if (y === 2021 && viewMonth < 9) setViewMonth(9);
                  }}
                  className="h-6 px-1 text-xs font-medium border border-line rounded bg-surface text-text cursor-pointer outline-none hover:border-line-strong"
                  aria-label="Select year"
                >
                  {availableYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                onClick={handleNextMonth}
                className="p-1 rounded text-muted hover:text-text hover:bg-surface-hover cursor-pointer"
                aria-label="Next month"
              >
                <ChevronRight size={14} />
              </button>
            </div>

            {/* Days of Week Header */}
            <div className="grid grid-cols-7 gap-1 text-center mb-1">
              {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
                <span key={d} className="text-[10px] font-semibold text-muted">
                  {d}
                </span>
              ))}
            </div>

            {/* Day Cells Grid */}
            <div className="grid grid-cols-7 gap-1">
              {calendarDays.map((cell, idx) => {
                if (!cell) {
                  return <div key={`empty-${idx}`} className="h-6 w-6" />;
                }

                const isSelected = cell.dateStr === (selectedDate || latestDate);
                const isToday = cell.dateStr === latestDate;

                return (
                  <button
                    key={cell.dateStr}
                    type="button"
                    disabled={!cell.isAvailable}
                    onClick={() => {
                      onChange(cell.dateStr === latestDate ? null : cell.dateStr);
                      setIsOpen(false);
                    }}
                    className={`h-6 w-6 mx-auto rounded text-xs flex items-center justify-center transition-all ${
                      isSelected
                        ? 'bg-accent text-white font-bold shadow-xs'
                        : cell.isAvailable
                        ? 'text-text hover:bg-surface-hover hover:text-accent font-medium cursor-pointer'
                        : 'text-muted/30 cursor-not-allowed'
                    } ${isToday && !isSelected ? 'ring-1 ring-accent/60 font-semibold' : ''}`}
                    title={
                      cell.isAvailable
                        ? `Session: ${cell.dateStr}${isToday ? ' (Latest)' : ''}`
                        : `${cell.dateStr} (No session data / Market holiday)`
                    }
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>

            {/* Popover Footer: Quick Jump to Latest */}
            <div className="mt-2 pt-2 border-t border-line flex items-center justify-between text-[11px]">
              <span className="text-[10px] text-muted">
                {availableSet.size} sessions available
              </span>
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  setIsOpen(false);
                }}
                className="text-accent hover:underline font-medium cursor-pointer"
              >
                Latest Session
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
};
