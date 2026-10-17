import React, { useState, useRef } from 'react';
import {useMutation} from '@tanstack/react-query';
import { Dialog } from './Dialog';
import { ArrowRight, CornerDownLeft, SlidersHorizontal, CheckCircle2, AlertCircle, RotateCcw, X } from 'lucide-react';
import { ActiveCondition, MatchMode } from '../types/screener';
import { compileNaturalLanguageQuery, SAMPLE_PROMPTS } from '../api/aiScreenerCompiler';
import {useFilterChoices} from '../hooks/useFilterChoices';

interface AiScreenerModalProps {
  isOpen: boolean;
  datasetRevision?: string;
  onClose: () => void;
  onApplyConditions: (conditions: Record<string, ActiveCondition>, immediateRun: boolean, matchMode: MatchMode) => void;
  onOpenFilterEditor: (conditions: Record<string, ActiveCondition>, matchMode: MatchMode) => void;
}

export const AiScreenerModal: React.FC<AiScreenerModalProps> = ({
  isOpen,
  datasetRevision,
  onClose,
  onApplyConditions,
  onOpenFilterEditor,
}) => {
  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const controller = useRef<AbortController | null>(null);
  const choices = useFilterChoices(isOpen && Boolean(datasetRevision),datasetRevision);
  const compilation = useMutation({
    mutationFn: (text: string) => {
      controller.current = new AbortController();
      return compileNaturalLanguageQuery(text, controller.current.signal,{datasetRevision,choices:choices.data});
    },
    retry: false,
  });
  const isCompiling = compilation.isPending;
  const result = compilation.data;
  const hasConditions = Boolean(result && Object.keys(result.conditionsMap).length);
  const canRun = hasConditions && result?.unsupportedClauses.length === 0;
  const handleClose = () => { controller.current?.abort(); onClose(); };

  if (!isOpen) return null;

  const handleCompile = (queryToUse?: string) => {
    const text = (queryToUse ?? inputText).trim();
    if (!text || isCompiling || datasetRevision && !choices.data) return;
    compilation.mutate(text);
  };

  const handleSampleClick = (sampleText: string) => {
    setInputText(sampleText);
    handleCompile(sampleText);
  };

  const handleRunNow = () => {
    if (!result || !canRun) return;
    onApplyConditions(result.conditionsMap, true, result.matchMode);
    handleClose();
  };

  const handleEditFirst = () => {
    if (!result || !hasConditions) return;
    onOpenFilterEditor(result.conditionsMap, result.matchMode);
    handleClose();
  };

  const handleReset = () => {
    compilation.reset();
    setInputText('');
    textareaRef.current?.focus();
  };

  return (
    <Dialog label="Ask in plain words" onClose={handleClose} className="ai-screener-dialog">
      <div className="dialog-header">
        <div>
          <div className="ai-dialog-title-row">
            <h2>Ask in plain words</h2>
          </div>
          <p>Describe stocks in English or Hinglish. Automatically translated into mathematical screener conditions.</p>
        </div>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={handleClose}>
          <X size={18} />
        </button>
      </div>

      <div className="dialog-content ai-dialog-content">
        {/* Input Composer Box */}
        <div className="ai-composer-card">
          <textarea
            ref={textareaRef}
            autoFocus
            maxLength={2000}
            aria-label="Describe your screen"
            value={inputText}
            onChange={(e) => {setInputText(e.target.value); compilation.reset();}}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleCompile();
              }
            }}
            rows={3}
            placeholder="e.g. Close 200 EMA ke upar aur volume kam se kam 2 times the 20 day average…"
            className="ai-textarea"
            disabled={isCompiling}
          />
          <div className="ai-composer-toolbar">
            <span className="ai-kbd-hint">
              <kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> to compile
            </span>
            <button
              type="button"
              onClick={() => handleCompile()}
              disabled={!inputText.trim() || isCompiling || Boolean(datasetRevision && !choices.data)}
              className="button button-primary"
            >
              {isCompiling ? (
                <>
                  <RotateCcw size={13} className="animate-spin" />
                  <span>Compiling…</span>
                </>
              ) : (
                <>
                  <span>Compile screen</span>
                  <CornerDownLeft size={13} />
                </>
              )}
            </button>
          </div>
        </div>

        {/* Status / Stepper Notification */}
        {isCompiling && (
          <div className="ai-progress-bar" role="status">
            <span className="ai-pulse-dot" />
            <span>
              Building filters with Workers AI…
            </span>
          </div>
        )}

        {datasetRevision && choices.isPending && <p role="status">Loading available filter choices…</p>}
        {datasetRevision && choices.isError && <div className="ai-caveat" role="alert">Filter choices could not be loaded.
          <button type="button" onClick={()=>void choices.refetch()}>Retry</button></div>}
        {compilation.isError && (
          <div className="ai-caveat" role="alert">
            <AlertCircle size={14} className="shrink-0" />
            <div>
              <span>{compilation.error.message}</span>
              <p className="mt-1 text-[11px] opacity-80">
                Tip: Try specifying clear parameters like moving averages (e.g. 50 EMA, 200 SMA), volume multiples, P/E ratio, or turnover.
              </p>
            </div>
          </div>
        )}

        {/* Sample queries chips */}
        {!result && !isCompiling && (
          <div className="ai-examples-section">
            <span className="ai-section-eyebrow">Example requests</span>
            <div className="ai-examples-grid">
              {SAMPLE_PROMPTS.map((sample) => (
                <button
                  key={sample.label}
                  type="button"
                  onClick={() => handleSampleClick(sample.text)}
                  className="ai-example-btn"
                  title={sample.text}
                >
                  <span className="ai-example-label">{sample.label}</span>
                  <ArrowRight size={12} className="ai-example-arrow" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Readback / Compiled Clauses */}
        {result && !isCompiling && (
          <div className="ai-readback-section">
            <div className="ai-readback-header">
              <div>
                <span className="ai-section-eyebrow">How I read it</span>
                <h3 className="ai-readback-title">{result.name}</h3>
                <p>{result.summary} Match {result.matchMode === 'all' ? 'all' : 'any'} conditions.</p>
              </div>
              <button type="button" onClick={handleReset} className="button button-ghost ai-start-over-btn">
                <RotateCcw size={12} />
                <span>Start over</span>
              </button>
            </div>

            <div className="ai-clauses-list">
              {result.clauses.map((clause, idx) => (
                <div key={idx} className="ai-clause-card">
                  <div className="ai-clause-top">
                    <span className="ai-clause-source">"{clause.sourceText}"</span>
                    <span className={`ai-clause-badge ${clause.status === 'EXACT' ? 'is-exact' : 'is-approx'}`}>
                      <CheckCircle2 size={11} />
                      {clause.status === 'EXACT' ? 'Exact Match' : clause.status === 'UNSUPPORTED' ? 'Unsupported' : 'Interpretation'}
                    </span>
                  </div>
                  <div className="ai-clause-emitted">
                    <span className="ai-clause-bullet" />
                    <strong>{clause.label}</strong>
                  </div>
                  {clause.assumption && (
                    <p className="ai-clause-note">Note: {clause.assumption}</p>
                  )}
                </div>
              ))}
            </div>

            {result.unsupportedClauses.length > 0 && (
              <div className="ai-caveat" role="alert">
                <AlertCircle size={14} />
                <span>
                  {result.unsupportedClauses.length} part(s) of your request need changes. Edit the supported filters or revise your request before running.
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="dialog-footer ai-dialog-footer">
        <div className="ai-dialog-actions" style={{ marginLeft: 'auto' }}>
          {result ? (
            <>
              <button
                type="button"
                onClick={handleEditFirst}
                disabled={!hasConditions}
                className="button button-secondary"
              >
                <SlidersHorizontal size={13} />
                <span>{result.unsupportedClauses.length ? 'Edit supported filters' : 'Edit conditions first'}</span>
              </button>
              <button
                type="button"
                onClick={handleRunNow}
                disabled={!canRun}
                className="button button-primary"
              >
                <span>Run this screen</span>
                <ArrowRight size={13} />
              </button>
            </>
          ) : (
            <button type="button" onClick={handleClose} className="button button-secondary">
              Cancel
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
};
