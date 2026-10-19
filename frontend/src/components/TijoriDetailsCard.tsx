import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, X, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { getTijoriOverviews } from '../api/tijori';
import { fetchLiveNews } from '../api/dhanNewsApi';
import symbolIsinMap from '../data/symbolIsinMap.json';
import { SymbolWithLogo } from './SymbolWithLogo';
import type { companyPopoverPosition } from '../utils/companyPopoverPosition';

type Tab = 'snapshot' | 'news' | 'watch' | 'events';
interface Props extends ReturnType<typeof companyPopoverPosition> {
  row: {symbol: string; name: string};
  id: string;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}
const date = (value: string) => new Date(`${value}T00:00:00+05:30`).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});

function formatRelative(epochMs: number): string {
  const diffSec = Math.floor((Date.now() - epochMs) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

export function TijoriDetailsCard({row, id, left, top, placement, onClose, onMouseEnter, onMouseLeave}: Props) {
  const query = useQuery({queryKey: ['tijori-overviews'], queryFn: getTijoriOverviews,
    staleTime: 30 * 60 * 1000, gcTime: 60 * 60 * 1000, retry: 1});
  const report = query.data?.[row.symbol];

  const stockIsin = (symbolIsinMap as Record<string, string>)[row.symbol];
  const newsQuery = useQuery({
    queryKey: ['stockHoverNews', row.symbol, stockIsin],
    queryFn: ({ signal }) => fetchLiveNews({ stockIsin: stockIsin || 'ALL', limit: 100, signal }),
    enabled: Boolean(stockIsin),
    staleTime: 60 * 1000,
  });

  const newsArticles = newsQuery.data?.articles ?? [];

  const tabs = [
    ...(report?.the_read?.length ? [{id: 'snapshot' as const, label: 'Snapshot'}] : []),
    ...(report?.what_to_watch?.length ? [{id: 'watch' as const, label: 'What to Watch'}] : []),
    ...(report?.key_events?.length ? [{id: 'events' as const, label: 'Key events'}] : []),
    ...(stockIsin ? [{id: 'news' as const, label: `News${newsArticles.length ? ` (${newsArticles.length})` : ''}`}] : []),
  ];
  const [requestedTab, setRequestedTab] = useState<Tab>('snapshot');
  const activeTab = tabs.some(tab => tab.id === requestedTab) ? requestedTab : tabs[0]?.id;
  const sourceUrl = report?.sourceUrl?.startsWith('https://www.tijorifinance.com/company/') ? report.sourceUrl : undefined;

  return createPortal(<section id={id} className="ipo-details-card tijori-details-card" role="dialog" aria-label={`${row.symbol} company snapshot`}
    style={{left, top, transformOrigin: placement === 'left' ? 'right 24px' : placement === 'sheet' ? 'center bottom' : 'left 24px'}}
    onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onFocus={onMouseEnter}
    onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget)) onMouseLeave();}}>
    <header className="ipo-details-header">
      <div className="ipo-details-company"><SymbolWithLogo symbol={row.symbol} name={row.name} /></div>
      <button type="button" className="icon-button ipo-details-close" onClick={onClose} aria-label="Close company snapshot"><X size={16} /></button>
    </header>
    {tabs.length > 0 && <div className="ipo-details-tabs" role="tablist" aria-label="Company snapshot sections">
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`${id}-${tab.id}-tab`}
        aria-selected={activeTab === tab.id} aria-controls={`${id}-${tab.id}-panel`} tabIndex={activeTab === tab.id ? 0 : -1}
        className={activeTab === tab.id ? 'active' : ''} onClick={() => setRequestedTab(tab.id)}
        onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); setRequestedTab(tabs[next].id);
          document.getElementById(`${id}-${tabs[next].id}-tab`)?.focus();
        }}>{tab.label}</button>)}
    </div>}
    <div key={activeTab ?? 'status'} className="ipo-details-content">
      {query.isPending && activeTab !== 'news' ? <div className="tijori-loading" role="status" aria-label="Loading company snapshot">
        <span className="skeleton" /><span className="skeleton" /><span className="skeleton" />
      </div> : query.isError && activeTab !== 'news' ? <div className="ipo-details-empty" role="alert"><p>Company snapshot could not be loaded.</p>
        <button className="button button-ghost" onClick={() => void query.refetch()}>Retry</button></div>
        : !tabs.length ? <p className="ipo-details-empty">No Tijori snapshot is available for this company.</p>
          : <div role="tabpanel" id={`${id}-${activeTab}-panel`} aria-labelledby={`${id}-${activeTab}-tab`} tabIndex={0}>
            {activeTab === 'snapshot' && report && <ul className="tijori-snapshot-list">{report.the_read.map((text, index) => <li key={index}>{text}</li>)}</ul>}
            
            {activeTab === 'news' && (
              <div className="hover-news-stream">
                {newsQuery.isPending ? (
                  <div className="tijori-loading" role="status" aria-label="Loading stock news">
                    <span className="skeleton" /><span className="skeleton" />
                  </div>
                ) : newsQuery.isError ? (
                  <div className="ipo-details-empty">
                    <p>Unable to load live news for {row.symbol}.</p>
                    <button type="button" className="button button-ghost" onClick={() => void newsQuery.refetch()}>
                      <RefreshCw size={12} /> Retry
                    </button>
                  </div>
                ) : newsArticles.length === 0 ? (
                  <p className="ipo-details-empty">No exchange filings or live news found for {row.symbol}.</p>
                ) : (
                  <div className="hover-news-list">
                    {newsArticles.map(article => {
                      const sentiment = article.news_object?.overall_sentiment || 'neutral';
                      return (
                        <article key={article.article_id} className="hover-news-item">
                          <div className="hover-news-row">
                            <span className={`hover-sentiment-badge is-${sentiment}`} title={`${sentiment} announcement`}>
                              {sentiment === 'positive' ? (
                                <TrendingUp size={11} />
                              ) : sentiment === 'negative' ? (
                                <TrendingDown size={11} />
                              ) : (
                                <Minus size={11} />
                              )}
                            </span>
                            <div className="hover-news-content">
                              <h4 className="hover-news-title">{article.news_object?.title}</h4>
                              <div className="hover-news-meta">
                                {article.sub_category && (
                                  <span className="hover-news-topic">
                                    {article.sub_category.replaceAll('-', ' ')}
                                  </span>
                                )}
                                <span className="hover-news-dot">·</span>
                                <time className="hover-news-time" dateTime={new Date(article.publish_date).toISOString()}>
                                  {formatRelative(article.publish_date)}
                                </time>
                              </div>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'watch' && report && <div className="tijori-watch-list">{report.what_to_watch.map((item, index) => <article key={index}>
              <h3>{item.title}</h3>{item.window && <span className="tijori-watch-window">{item.window}</span>}
              {item.body && <p>{item.body}</p>}
            </article>)}</div>}

            {activeTab === 'events' && report && <div className="tijori-watch-list">{report.key_events.map((event, index) => <article key={index}>
              {event.chart_date && <time className="tijori-watch-window" dateTime={event.chart_date}>{date(event.chart_date)}</time>}
              <p>{event.label}</p>
            </article>)}</div>}
          </div>}
    </div>
    {report && <footer className="tijori-details-footer">
      {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="View source" title="View source"><ExternalLink size={12} /></a>}
      {report.as_of && <span>As of {date(report.as_of)}</span>}
    </footer>}
  </section>, document.body);
}
