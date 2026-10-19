import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { 
  TrendingUp, 
  TrendingDown, 
  Minus, 
  RefreshCw, 
  Search, 
  Clock, 
  Copy, 
  Check, 
  Filter, 
  Radio, 
  Building2, 
  X,
  LayoutList,
  LayoutGrid
} from 'lucide-react';
import { fetchLiveNews, type DhanNewsArticle } from '../api/dhanNewsApi';

const SUB_CATEGORIES = [
  { id: 'ALL', label: 'All Categories' },
  { id: 'earnings-financial-results', label: 'Earnings & Results' },
  { id: 'corporate-actions', label: 'Corporate Actions' },
  { id: 'management-leadership', label: 'Board & Leadership' },
  { id: 'legal-compliance', label: 'Regulatory & Compliance' },
  { id: 'strategic-partnerships', label: 'M&A & Joint Ventures' },
  { id: 'operational-updates', label: 'Orders & Operations' },
];

const MARKET_CAPS = [
  { id: 'ALL', label: 'All Caps' },
  { id: 'Large Cap', label: 'Large Cap' },
  { id: 'Mid Cap', label: 'Mid Cap' },
  { id: 'Small Cap', label: 'Small Cap' },
];

function formatTimeAgo(epochMs: number): string {
  const diffSec = Math.floor((Date.now() - epochMs) / 1000);
  if (diffSec < 60) return `${Math.max(1, diffSec)}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
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
  const [viewMode, setViewMode] = useState<'stream' | 'grid'>('stream');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSentiment, setSelectedSentiment] = useState<'ALL' | 'positive' | 'negative' | 'neutral'>('ALL');
  const [selectedSubCat, setSelectedSubCat] = useState('ALL');
  const [selectedMarketCap, setSelectedMarketCap] = useState('ALL');
  const [activeStockIsin, setActiveStockIsin] = useState<string | null>(null);
  const [activeStockSymbol, setActiveStockSymbol] = useState<string | null>(null);
  const [activeStockName, setActiveStockName] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
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

  const handleFilterStock = (article: DhanNewsArticle) => {
    if (!article.isin_code) return;
    setActiveStockIsin(article.isin_code);
    setActiveStockSymbol(article.sm_symbol || article.stock_name);
    setActiveStockName(article.stock_name);
    setAccumulatedArticles([]);
    setPageCursor({ page: 0, firstTs: 0, lastTs: 0 });
  };

  const handleClearStockFilter = () => {
    setActiveStockIsin(null);
    setActiveStockSymbol(null);
    setActiveStockName(null);
    setAccumulatedArticles([]);
    setPageCursor({ page: 0, firstTs: 0, lastTs: 0 });
  };

  const handleCopy = (article: DhanNewsArticle) => {
    const text = `${article.sm_symbol} - ${article.news_object.title}\n${article.news_object.text}\nSentiment: ${article.news_object.overall_sentiment.toUpperCase()} | Date: ${formatFullDate(article.publish_date)}`;
    navigator.clipboard.writeText(text);
    setCopiedId(article.article_id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const filteredArticles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return allArticles.filter(a => {
      if (selectedSentiment !== 'ALL' && a.news_object?.overall_sentiment !== selectedSentiment) {
        return false;
      }
      if (selectedSubCat !== 'ALL' && a.sub_category !== selectedSubCat) {
        return false;
      }
      if (selectedMarketCap !== 'ALL' && a.metadata?.marketcap !== selectedMarketCap) {
        return false;
      }
      if (query) {
        const sym = (a.sm_symbol || '').toLowerCase();
        const name = (a.stock_name || '').toLowerCase();
        const title = (a.news_object?.title || '').toLowerCase();
        const text = (a.news_object?.text || '').toLowerCase();
        const sector = (a.metadata?.sector_name || '').toLowerCase();
        if (!sym.includes(query) && !name.includes(query) && !title.includes(query) && !text.includes(query) && !sector.includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [allArticles, selectedSentiment, selectedSubCat, selectedMarketCap, searchQuery]);

  const { positiveCount, negativeCount, neutralCount, totalCount } = useMemo(() => {
    let pos = 0, neg = 0, neu = 0;
    for (const a of allArticles) {
      const s = a.news_object?.overall_sentiment;
      if (s === 'positive') pos++;
      else if (s === 'negative') neg++;
      else neu++;
    }
    return {
      positiveCount: pos,
      negativeCount: neg,
      neutralCount: neu,
      totalCount: allArticles.length,
    };
  }, [allArticles]);

  return (
    <div className="news-view">
      {/* Sleek Top Bar */}
      <header className="news-header">
        <div className="news-title-group">
          <div className="news-title-row">
            <h1 className="news-title">News & Catalyst Stream</h1>
            <span className="news-live-badge">
              <span className="pulse-dot" />
              Live
            </span>
          </div>
          <p className="news-subtitle">
            Real-time corporate disclosures, earnings releases, and AI sentiment analysis
          </p>
        </div>

        <div className="news-controls-right">
          <button
            type="button"
            className={`news-control-pill ${autoRefresh ? 'news-control-pill--active' : ''}`}
            onClick={() => setAutoRefresh(prev => !prev)}
            title="Toggle 30-second live auto-refresh"
          >
            <Radio size={13} className={autoRefresh ? 'pulse-dot' : ''} />
            <span>Live Sync</span>
          </button>
          <button
            type="button"
            className="news-control-pill"
            onClick={() => void refetch()}
            disabled={isFetching}
            title="Refresh announcements now"
          >
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {/* Modern Filter Ribbon */}
      <section className="news-stats-ribbon" aria-label="Sentiment overview">
        <div
          role="button"
          tabIndex={0}
          className={`news-stat-item ${selectedSentiment === 'ALL' ? 'news-stat-item--selected' : ''}`}
          onClick={() => setSelectedSentiment('ALL')}
          onKeyDown={e => e.key === 'Enter' && setSelectedSentiment('ALL')}
        >
          <span className="news-stat-indicator news-stat-indicator--all" />
          <span className="news-stat-count">{totalCount}</span>
          <span className="news-stat-label">All Updates</span>
        </div>

        <div
          role="button"
          tabIndex={0}
          className={`news-stat-item ${selectedSentiment === 'positive' ? 'news-stat-item--selected' : ''}`}
          onClick={() => setSelectedSentiment('positive')}
          onKeyDown={e => e.key === 'Enter' && setSelectedSentiment('positive')}
        >
          <span className="news-stat-indicator news-stat-indicator--positive" />
          <span className="news-stat-count" style={{ color: '#10b981' }}>{positiveCount}</span>
          <span className="news-stat-label">Bullish / Positive</span>
        </div>

        <div
          role="button"
          tabIndex={0}
          className={`news-stat-item ${selectedSentiment === 'neutral' ? 'news-stat-item--selected' : ''}`}
          onClick={() => setSelectedSentiment('neutral')}
          onKeyDown={e => e.key === 'Enter' && setSelectedSentiment('neutral')}
        >
          <span className="news-stat-indicator news-stat-indicator--neutral" />
          <span className="news-stat-count">{neutralCount}</span>
          <span className="news-stat-label">Neutral / Filing</span>
        </div>

        <div
          role="button"
          tabIndex={0}
          className={`news-stat-item ${selectedSentiment === 'negative' ? 'news-stat-item--selected' : ''}`}
          onClick={() => setSelectedSentiment('negative')}
          onKeyDown={e => e.key === 'Enter' && setSelectedSentiment('negative')}
        >
          <span className="news-stat-indicator news-stat-indicator--negative" />
          <span className="news-stat-count" style={{ color: '#f43f5e' }}>{negativeCount}</span>
          <span className="news-stat-label">Bearish / Risk</span>
        </div>
      </section>

      {/* Minimal Unified Toolbar */}
      <div className="news-toolbar">
        <div className="news-toolbar-left">
          <div className="news-search-input-wrap">
            <Search size={13} className="text-muted" />
            <input
              type="text"
              placeholder="Filter by company, ticker, headline, sector..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)', padding: 0 }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="news-toolbar-right">
          <select
            className="news-clean-select"
            value={selectedSubCat}
            onChange={e => setSelectedSubCat(e.target.value)}
            aria-label="Filter by category"
          >
            {SUB_CATEGORIES.map(cat => (
              <option key={cat.id} value={cat.id}>
                {cat.label}
              </option>
            ))}
          </select>

          <select
            className="news-clean-select"
            value={selectedMarketCap}
            onChange={e => setSelectedMarketCap(e.target.value)}
            aria-label="Filter by market capitalization"
          >
            {MARKET_CAPS.map(cap => (
              <option key={cap.id} value={cap.id}>
                {cap.label}
              </option>
            ))}
          </select>

          <div className="news-view-mode-group">
            <button
              type="button"
              className={`news-view-mode-btn ${viewMode === 'stream' ? 'news-view-mode-btn--active' : ''}`}
              onClick={() => setViewMode('stream')}
              title="Stream view"
            >
              <LayoutList size={13} />
            </button>
            <button
              type="button"
              className={`news-view-mode-btn ${viewMode === 'grid' ? 'news-view-mode-btn--active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="Grid view"
            >
              <LayoutGrid size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* Stock Focus Filter Banner */}
      {activeStockIsin && (
        <div className="news-stock-focus-banner">
          <div className="news-stock-focus-info">
            <Building2 size={15} color="var(--accent)" />
            <span className="news-stock-badge-large">{activeStockSymbol}</span>
            <span className="news-stock-focus-desc">
              {activeStockName && activeStockName !== activeStockSymbol ? activeStockName : 'Company timeline'} · 2-year filings
            </span>
          </div>
          <button
            type="button"
            className="news-stock-clear-btn"
            onClick={handleClearStockFilter}
          >
            <X size={12} />
            <span>Clear Filter</span>
          </button>
        </div>
      )}

      {/* News Stream / Grid */}
      <main className={viewMode === 'stream' ? 'news-feed-stream' : 'news-feed-grid'}>
        {isPending && allArticles.length === 0 ? (
          <div className="news-empty-state" style={{ gridColumn: '1 / -1' }}>
            <RefreshCw size={20} className="animate-spin text-muted" />
            <h3>Connecting to Exchange Feed</h3>
            <p>Gathering real-time corporate announcements...</p>
          </div>
        ) : error && allArticles.length === 0 ? (
          <div className="news-empty-state" style={{ gridColumn: '1 / -1' }}>
            <h3>Feed Temporarily Unavailable</h3>
            <p>{(error as Error).message}</p>
            <button
              type="button"
              className="button button-primary"
              style={{ marginTop: '12px' }}
              onClick={() => void refetch()}
            >
              Try Again
            </button>
          </div>
        ) : filteredArticles.length === 0 ? (
          <div className="news-empty-state" style={{ gridColumn: '1 / -1' }}>
            <Filter size={20} className="text-muted" />
            <h3>No Announcements Found</h3>
            <p>Try modifying your search or clearing active filters.</p>
          </div>
        ) : (
          filteredArticles.map(article => {
            const sentiment = article.news_object?.overall_sentiment || 'neutral';
            const isCopied = copiedId === article.article_id;

            return (
              <article
                key={article.article_id}
                className={`news-item-card news-item-card--${sentiment}`}
              >
                <div className="news-item-header">
                  <div className="news-item-stock">
                    <button
                      type="button"
                      className="news-ticker-pill"
                      onClick={() => handleFilterStock(article)}
                      title={`Filter by ${article.sm_symbol || article.stock_name} (2-Year History)`}
                    >
                      {article.sm_symbol || 'CORP'}
                    </button>
                    <span className="news-company-text" title={article.stock_name}>
                      {article.stock_name}
                    </span>
                    {article.metadata?.marketcap && (
                      <span className="news-tag-micro">{article.metadata.marketcap}</span>
                    )}
                    {article.metadata?.sector_name && (
                      <span className="news-tag-micro">{article.metadata.sector_name}</span>
                    )}
                  </div>

                  <div className="news-item-meta">
                    <span className={`news-sentiment-badge news-sentiment-badge--${sentiment}`}>
                      {sentiment === 'positive' ? (
                        <TrendingUp size={11} />
                      ) : sentiment === 'negative' ? (
                        <TrendingDown size={11} />
                      ) : (
                        <Minus size={11} />
                      )}
                      <span>{sentiment}</span>
                    </span>
                    <span className="news-time-label" title={formatFullDate(article.publish_date)}>
                      <Clock size={10} style={{ display: 'inline', marginRight: '3px' }} />
                      {formatTimeAgo(article.publish_date)}
                    </span>
                  </div>
                </div>

                <h2 className="news-item-headline">{article.news_object?.title}</h2>

                {article.news_object?.text && (
                  <p className="news-item-summary">{article.news_object.text}</p>
                )}

                <footer className="news-item-footer">
                  <span className="news-category-label">
                    {article.sub_category ? article.sub_category.replaceAll('-', ' ') : 'General'}
                  </span>

                  <div className="news-action-toolbar">
                    <button
                      type="button"
                      className="news-action-btn-clean"
                      onClick={() => handleFilterStock(article)}
                      title="View all historical filings for this stock"
                    >
                      <Building2 size={11} />
                      <span>Timeline</span>
                    </button>
                    <button
                      type="button"
                      className="news-action-btn-clean"
                      onClick={() => handleCopy(article)}
                      title="Copy synopsis to clipboard"
                    >
                      {isCopied ? <Check size={11} color="#10b981" /> : <Copy size={11} />}
                      <span>{isCopied ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </footer>
              </article>
            );
          })
        )}
      </main>

      {/* Clean Load Earlier Bar */}
      {allArticles.length > 0 && (
        <div className="news-load-more-bar">
          <button
            type="button"
            className="news-clean-load-btn"
            onClick={handleLoadMore}
            disabled={isFetching}
          >
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
            <span>{isFetching ? 'Loading earlier records...' : 'Load Earlier Announcements'}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default NewsTab;
