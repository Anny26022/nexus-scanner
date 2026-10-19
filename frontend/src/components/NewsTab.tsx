import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { 
  Search, 
  RefreshCw, 
  Copy, 
  Check, 
  X,
  ExternalLink,
  ChevronRight,
  TrendingUp,
  TrendingDown
} from 'lucide-react';
import { fetchLiveNews, type DhanNewsArticle } from '../api/dhanNewsApi';

const TOPIC_FILTERS = [
  { id: 'ALL', label: 'All' },
  { id: 'earnings-financial-results', label: 'Earnings' },
  { id: 'corporate-actions', label: 'Corporate Actions' },
  { id: 'management-leadership', label: 'Leadership' },
  { id: 'legal-compliance', label: 'Regulatory' },
  { id: 'strategic-partnerships', label: 'M&A / JV' },
  { id: 'operational-updates', label: 'Contracts' },
];

function formatTimeAgo(epochMs: number): string {
  const diffSec = Math.floor((Date.now() - epochMs) / 1000);
  if (diffSec < 60) return `${Math.max(1, diffSec)}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d`;
}

function formatFullDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function NewsTab() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSentiment, setSelectedSentiment] = useState<'ALL' | 'positive' | 'negative' | 'neutral'>('ALL');
  const [selectedTopic, setSelectedTopic] = useState('ALL');
  const [activeStockIsin, setActiveStockIsin] = useState<string | null>(null);
  const [activeStockSymbol, setActiveStockSymbol] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [accumulatedArticles, setAccumulatedArticles] = useState<DhanNewsArticle[]>([]);
  const [pageCursor, setPageCursor] = useState<{ page: number; firstTs: number; lastTs: number }>({
    page: 0,
    firstTs: 0,
    lastTs: 0,
  });

  const queryIsin = activeStockIsin || 'ALL';
  const { data: pageResult, isPending, isFetching, error, refetch } = useQuery({
    queryKey: ['dhanLiveNews', queryIsin, pageCursor.page, pageCursor.firstTs, pageCursor.lastTs],
    queryFn: ({ signal }) =>
      fetchLiveNews({
        stockIsin: queryIsin,
        limit: 100,
        pageNo: pageCursor.page,
        firstNewsTimeStamp: pageCursor.firstTs,
        lastNewsTimeStamp: pageCursor.lastTs,
        signal,
      }),
    refetchInterval: autoRefresh && pageCursor.page === 0 ? 30_000 : false,
    staleTime: 15_000,
  });

  const allArticles = useMemo(() => {
    const fresh = pageResult?.articles ?? [];
    if (pageCursor.page === 0) {
      return fresh;
    }
    const existingIds = new Set(accumulatedArticles.map(a => a.article_id));
    const newItems = fresh.filter(a => !existingIds.has(a.article_id));
    return [...accumulatedArticles, ...newItems];
  }, [pageResult, pageCursor.page, accumulatedArticles]);

  const handleLoadMore = () => {
    if (!pageResult || pageResult.articles.length === 0) return;
    setAccumulatedArticles(allArticles);
    setPageCursor(prev => ({
      page: prev.page + 1,
      firstTs: prev.firstTs || pageResult.firstTs,
      lastTs: pageResult.lastTs,
    }));
  };

  const handleFilterStock = (article: DhanNewsArticle, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!article.isin_code) return;
    setActiveStockIsin(article.isin_code);
    setActiveStockSymbol(article.sm_symbol || article.stock_name);
    setAccumulatedArticles([]);
    setPageCursor({ page: 0, firstTs: 0, lastTs: 0 });
  };

  const handleClearStockFilter = () => {
    setActiveStockIsin(null);
    setActiveStockSymbol(null);
    setAccumulatedArticles([]);
    setPageCursor({ page: 0, firstTs: 0, lastTs: 0 });
  };

  const handleCopy = (article: DhanNewsArticle, e: React.MouseEvent) => {
    e.stopPropagation();
    const text = `${article.sm_symbol} · ${article.news_object.title}\n${article.news_object.text}\nDate: ${formatFullDate(article.publish_date)}`;
    navigator.clipboard.writeText(text);
    setCopiedId(article.article_id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const filteredArticles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return allArticles.filter(a => {
      if (selectedSentiment !== 'ALL' && a.news_object?.overall_sentiment !== selectedSentiment) {
        return false;
      }
      if (selectedTopic !== 'ALL' && a.sub_category !== selectedTopic) {
        return false;
      }
      if (query) {
        const sym = (a.sm_symbol || '').toLowerCase();
        const name = (a.stock_name || '').toLowerCase();
        const title = (a.news_object?.title || '').toLowerCase();
        const text = (a.news_object?.text || '').toLowerCase();
        if (!sym.includes(query) && !name.includes(query) && !title.includes(query) && !text.includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [allArticles, selectedSentiment, selectedTopic, searchQuery]);

  const counts = useMemo(() => {
    let pos = 0, neg = 0, neu = 0;
    for (const a of allArticles) {
      const s = a.news_object?.overall_sentiment;
      if (s === 'positive') pos++;
      else if (s === 'negative') neg++;
      else neu++;
    }
    return { pos, neg, neu, total: allArticles.length };
  }, [allArticles]);

  return (
    <div className="ap-news-layout">
      {/* Apple Minimalist Header Strip */}
      <header className="ap-header">
        <div className="ap-header-title-row">
          <div className="ap-header-title-wrap">
            <h1 className="ap-header-title">Live Wire</h1>
            <span className="ap-live-dot" title="Live exchange announcements feed" />
          </div>
          <span className="ap-header-sub">
            {activeStockSymbol ? (
              <span className="ap-active-stock-indicator">
                Showing 2-year history for <strong>{activeStockSymbol}</strong>
                <button type="button" onClick={handleClearStockFilter} aria-label="Clear stock filter">
                  <X size={11} />
                </button>
              </span>
            ) : (
              'Real-time corporate disclosures & filings'
            )}
          </span>
        </div>

        <div className="ap-header-actions">
          <button
            type="button"
            className={`ap-subtle-toggle ${autoRefresh ? 'is-active' : ''}`}
            onClick={() => setAutoRefresh(v => !v)}
            title="Auto-refresh incoming feed every 30s"
          >
            <span className="ap-toggle-pip" />
            <span>Live Sync</span>
          </button>

          <button
            type="button"
            className="ap-icon-btn"
            onClick={() => void refetch()}
            disabled={isFetching}
            title="Refresh now"
            aria-label="Refresh"
          >
            <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      {/* Filter Bar: Pure Clean Inline Controls */}
      <nav className="ap-filter-bar" aria-label="News filters">
        <div className="ap-search-wrap">
          <Search size={13} className="ap-search-icon" />
          <input
            type="text"
            className="ap-search-input"
            placeholder="Search company, ticker, headline..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="ap-search-clear"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Sentiment Segment Control */}
        <div className="ap-segmented-control" role="tablist" aria-label="Sentiment filter">
          <button
            type="button"
            role="tab"
            aria-selected={selectedSentiment === 'ALL'}
            className={`ap-segment-btn ${selectedSentiment === 'ALL' ? 'is-active' : ''}`}
            onClick={() => setSelectedSentiment('ALL')}
          >
            All <span className="ap-counter">{counts.total}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedSentiment === 'positive'}
            className={`ap-segment-btn ${selectedSentiment === 'positive' ? 'is-active is-positive' : ''}`}
            onClick={() => setSelectedSentiment('positive')}
          >
            <TrendingUp size={11} />
            Positive <span className="ap-counter">{counts.pos}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedSentiment === 'negative'}
            className={`ap-segment-btn ${selectedSentiment === 'negative' ? 'is-active is-negative' : ''}`}
            onClick={() => setSelectedSentiment('negative')}
          >
            <TrendingDown size={11} />
            Negative <span className="ap-counter">{counts.neg}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={selectedSentiment === 'neutral'}
            className={`ap-segment-btn ${selectedSentiment === 'neutral' ? 'is-active' : ''}`}
            onClick={() => setSelectedSentiment('neutral')}
          >
            Neutral <span className="ap-counter">{counts.neu}</span>
          </button>
        </div>

        {/* Topic Pills */}
        <div className="ap-topic-scroller">
          {TOPIC_FILTERS.map(topic => (
            <button
              key={topic.id}
              type="button"
              className={`ap-topic-pill ${selectedTopic === topic.id ? 'is-active' : ''}`}
              onClick={() => setSelectedTopic(topic.id)}
            >
              {topic.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Main Stream List: Borderless, Pure Typography & Whitespace */}
      <main className="ap-stream-list" role="feed">
        {isPending && allArticles.length === 0 ? (
          <div className="ap-empty-state">
            <RefreshCw size={18} className="animate-spin text-muted" />
            <p>Connecting to exchange wire...</p>
          </div>
        ) : error && allArticles.length === 0 ? (
          <div className="ap-empty-state">
            <p>{(error as Error).message}</p>
            <button type="button" className="ap-link-btn" onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        ) : filteredArticles.length === 0 ? (
          <div className="ap-empty-state">
            <p>No filings match your criteria</p>
            <button
              type="button"
              className="ap-link-btn"
              onClick={() => {
                setSearchQuery('');
                setSelectedSentiment('ALL');
                setSelectedTopic('ALL');
                handleClearStockFilter();
              }}
            >
              Reset filters
            </button>
          </div>
        ) : (
          filteredArticles.map(article => {
            const sentiment = article.news_object?.overall_sentiment || 'neutral';
            const isExpanded = expandedId === article.article_id;
            const isCopied = copiedId === article.article_id;
            const symbol = article.sm_symbol || 'CORP';

            return (
              <article
                key={article.article_id}
                className={`ap-entry-row ap-sentiment-${sentiment} ${isExpanded ? 'is-expanded' : ''}`}
                onClick={() => setExpandedId(isExpanded ? null : article.article_id)}
                role="article"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setExpandedId(isExpanded ? null : article.article_id);
                  }
                }}
              >
                {/* Micro Sentiment Dot Column */}
                <div className="ap-entry-dot-col">
                  <span className={`ap-sentiment-dot is-${sentiment}`} />
                </div>

                {/* Main Content Area */}
                <div className="ap-entry-main">
                  {/* Metadata Row: Symbol, Company, Time */}
                  <div className="ap-entry-meta">
                    <button
                      type="button"
                      className="ap-symbol-text"
                      onClick={e => handleFilterStock(article, e)}
                      title={`Filter all announcements for ${symbol}`}
                    >
                      {symbol}
                    </button>
                    <span className="ap-company-name">{article.stock_name}</span>

                    {article.metadata?.marketcap && (
                      <span className="ap-subtle-tag">{article.metadata.marketcap}</span>
                    )}

                    {article.sub_category && (
                      <span className="ap-subtle-tag ap-topic-tag">
                        {article.sub_category.replaceAll('-', ' ')}
                      </span>
                    )}

                    <time
                      dateTime={new Date(article.publish_date).toISOString()}
                      className="ap-entry-time"
                      title={formatFullDate(article.publish_date)}
                    >
                      {formatTimeAgo(article.publish_date)}
                    </time>
                  </div>

                  {/* Headline: Clean, Crisp Typography */}
                  <h2 className="ap-entry-headline">{article.news_object?.title}</h2>

                  {/* Synopsis: Clean inline text with no heavy box */}
                  {article.news_object?.text && (
                    <p className={`ap-entry-body ${isExpanded ? 'is-full' : ''}`}>
                      {article.news_object.text}
                    </p>
                  )}

                  {/* Expanded Detail Tray */}
                  {isExpanded && (
                    <div className="ap-expanded-tray" onClick={e => e.stopPropagation()}>
                      <div className="ap-tray-details">
                        <span>ISIN: <code>{article.isin_code || 'N/A'}</code></span>
                        {article.metadata?.sector_name && (
                          <span>Sector: <strong>{article.metadata.sector_name}</strong></span>
                        )}
                        <span>Published: {formatFullDate(article.publish_date)}</span>
                      </div>

                      <div className="ap-tray-actions">
                        <button
                          type="button"
                          className="ap-tray-btn"
                          onClick={e => handleFilterStock(article, e)}
                        >
                          View 2-Year Filings
                          <ChevronRight size={12} />
                        </button>
                        <button
                          type="button"
                          className="ap-tray-btn"
                          onClick={e => handleCopy(article, e)}
                        >
                          {isCopied ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                          {isCopied ? 'Copied' : 'Copy Text'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right Quick Actions (Quiet Hover State) */}
                <div className="ap-entry-hover-actions">
                  <button
                    type="button"
                    className="ap-quick-action"
                    onClick={e => handleCopy(article, e)}
                    title="Copy announcement summary"
                    aria-label="Copy summary"
                  >
                    {isCopied ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                  </button>
                  <button
                    type="button"
                    className="ap-quick-action"
                    onClick={e => handleFilterStock(article, e)}
                    title={`View company history (${symbol})`}
                    aria-label="View history"
                  >
                    <ExternalLink size={12} />
                  </button>
                </div>
              </article>
            );
          })
        )}

        {/* Load More Trigger */}
        {allArticles.length > 0 && (
          <div className="ap-load-more-section">
            <button
              type="button"
              className="ap-load-more-btn"
              onClick={handleLoadMore}
              disabled={isFetching}
            >
              {isFetching ? 'Loading earlier records...' : 'Earlier Filings'}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default NewsTab;
