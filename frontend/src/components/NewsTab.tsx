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
  X
} from 'lucide-react';
import { fetchLiveNews, type DhanNewsArticle } from '../api/dhanNewsApi';

const SUB_CATEGORIES = [
  { id: 'ALL', label: 'All Topics' },
  { id: 'earnings-financial-results', label: 'Earnings & Results' },
  { id: 'corporate-actions', label: 'Corporate Actions' },
  { id: 'management-leadership', label: 'Management & Board' },
  { id: 'legal-compliance', label: 'Legal & Regulatory' },
  { id: 'strategic-partnerships', label: 'M&A & Partnerships' },
  { id: 'operational-updates', label: 'Operations & Orders' },
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

  // Main feed query
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

  // Merge articles without useEffect: compute articles derived from initial query + appended pages
  const allArticles = useMemo(() => {
    const fresh = pageResult?.articles ?? [];
    if (pageCursor.page === 0) {
      return fresh;
    }
    // De-duplicate on article_id
    const existingIds = new Set(accumulatedArticles.map(a => a.article_id));
    const newItems = fresh.filter(a => !existingIds.has(a.article_id));
    return [...accumulatedArticles, ...newItems];
  }, [pageResult, pageCursor.page, accumulatedArticles]);

  // Handle Load More
  const handleLoadMore = () => {
    if (!pageResult || pageResult.articles.length === 0) return;
    setAccumulatedArticles(allArticles);
    setPageCursor(prev => ({
      page: prev.page + 1,
      firstTs: prev.firstTs || pageResult.firstTs,
      lastTs: pageResult.lastTs,
    }));
  };

  // Filter by Stock
  const handleFilterStock = (article: DhanNewsArticle) => {
    if (!article.isin_code) return;
    setActiveStockIsin(article.isin_code);
    setActiveStockSymbol(article.sm_symbol || article.stock_name);
    setActiveStockName(article.stock_name);
    setAccumulatedArticles([]);
    setPageCursor({ page: 0, firstTs: 0, lastTs: 0 });
  };

  // Clear Stock Filter
  const handleClearStockFilter = () => {
    setActiveStockIsin(null);
    setActiveStockSymbol(null);
    setActiveStockName(null);
    setAccumulatedArticles([]);
    setPageCursor({ page: 0, firstTs: 0, lastTs: 0 });
  };

  // Copy Summary
  const handleCopy = (article: DhanNewsArticle) => {
    const text = `${article.sm_symbol} - ${article.news_object.title}\n${article.news_object.text}\nSentiment: ${article.news_object.overall_sentiment.toUpperCase()} | Date: ${formatFullDate(article.publish_date)}`;
    navigator.clipboard.writeText(text);
    setCopiedId(article.article_id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Derived in-memory filtering for instant response
  const filteredArticles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return allArticles.filter(a => {
      // Sentiment filter
      if (selectedSentiment !== 'ALL' && a.news_object?.overall_sentiment !== selectedSentiment) {
        return false;
      }
      // Sub-category filter
      if (selectedSubCat !== 'ALL' && a.sub_category !== selectedSubCat) {
        return false;
      }
      // Market cap filter
      if (selectedMarketCap !== 'ALL' && a.metadata?.marketcap !== selectedMarketCap) {
        return false;
      }
      // Search query
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

  // KPI Calculations across loaded universe
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
      {/* Top Header */}
      <div className="news-header">
        <div className="news-title-group">
          <div className="news-title-row">
            <h1 className="news-title">News & Catalyst Intelligence</h1>
            <span className="news-live-badge">
              <span className="pulse-dot" />
              Live Stream
            </span>
          </div>
          <p className="news-subtitle">
            Real-time exchange regulatory announcements, financial results, and NLP sentiment analysis
          </p>
        </div>

        <div className="news-controls-right">
          <button
            type="button"
            className={`news-toggle-btn ${autoRefresh ? 'news-toggle-btn--active' : ''}`}
            onClick={() => setAutoRefresh(prev => !prev)}
            title="Toggle 30-second live auto-refresh"
          >
            <Radio size={14} className={autoRefresh ? 'pulse-dot' : ''} />
            Auto-Refresh {autoRefresh ? 'ON' : 'OFF'}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void refetch()}
            disabled={isFetching}
            title="Fetch latest announcements"
          >
            <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Stats Ribbon */}
      <div className="news-stats-ribbon">
        <div className="news-stat-card">
          <div className="news-stat-icon-wrap news-stat-icon-wrap--total">
            <Radio size={16} />
          </div>
          <div className="news-stat-info">
            <span className="news-stat-value">{totalCount}</span>
            <span className="news-stat-label">Announcements Loaded</span>
          </div>
        </div>

        <div className="news-stat-card">
          <div className="news-stat-icon-wrap news-stat-icon-wrap--bullish">
            <TrendingUp size={16} />
          </div>
          <div className="news-stat-info">
            <span className="news-stat-value">
              {positiveCount} <span style={{ fontSize: '12px', fontWeight: 500, color: '#10b981' }}>
                ({totalCount ? Math.round((positiveCount / totalCount) * 100) : 0}%)
              </span>
            </span>
            <span className="news-stat-label">Positive Catalysts</span>
          </div>
        </div>

        <div className="news-stat-card">
          <div className="news-stat-icon-wrap news-stat-icon-wrap--neutral">
            <Minus size={16} />
          </div>
          <div className="news-stat-info">
            <span className="news-stat-value">
              {neutralCount} <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--muted)' }}>
                ({totalCount ? Math.round((neutralCount / totalCount) * 100) : 0}%)
              </span>
            </span>
            <span className="news-stat-label">Neutral / Routine Filings</span>
          </div>
        </div>

        <div className="news-stat-card">
          <div className="news-stat-icon-wrap news-stat-icon-wrap--bearish">
            <TrendingDown size={16} />
          </div>
          <div className="news-stat-info">
            <span className="news-stat-value">
              {negativeCount} <span style={{ fontSize: '12px', fontWeight: 500, color: '#f43f5e' }}>
                ({totalCount ? Math.round((negativeCount / totalCount) * 100) : 0}%)
              </span>
            </span>
            <span className="news-stat-label">Negative / Risk Events</span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="news-filter-strip">
        <div className="news-filter-row">
          <div className="news-search-box">
            <Search size={14} className="text-muted" />
            <input
              type="text"
              placeholder="Search by company, ticker, headline, or keywords..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)' }}
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="sentiment-pills" role="radiogroup" aria-label="Filter by Sentiment">
            <button
              type="button"
              className={`sentiment-pill ${selectedSentiment === 'ALL' ? 'sentiment-pill--active' : ''}`}
              onClick={() => setSelectedSentiment('ALL')}
            >
              All
            </button>
            <button
              type="button"
              className={`sentiment-pill sentiment-pill--bullish ${selectedSentiment === 'positive' ? 'sentiment-pill--active' : ''}`}
              onClick={() => setSelectedSentiment('positive')}
            >
              <TrendingUp size={11} /> Positive ({positiveCount})
            </button>
            <button
              type="button"
              className={`sentiment-pill ${selectedSentiment === 'neutral' ? 'sentiment-pill--active' : ''}`}
              onClick={() => setSelectedSentiment('neutral')}
            >
              <Minus size={11} /> Neutral ({neutralCount})
            </button>
            <button
              type="button"
              className={`sentiment-pill sentiment-pill--bearish ${selectedSentiment === 'negative' ? 'sentiment-pill--active' : ''}`}
              onClick={() => setSelectedSentiment('negative')}
            >
              <TrendingDown size={11} /> Negative ({negativeCount})
            </button>
          </div>
        </div>

        <div className="news-secondary-filters">
          <select
            className="news-select"
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
            className="news-select"
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

          {activeStockIsin && (
            <div className="news-stock-tag">
              <Building2 size={12} />
              <span>Filtering: {activeStockSymbol}{activeStockName && activeStockName !== activeStockSymbol ? ` (${activeStockName})` : ''}</span>
              <button
                type="button"
                onClick={handleClearStockFilter}
                title="Clear stock filter & return to market-wide stream"
              >
                <X size={12} />
              </button>
            </div>
          )}

          <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: 'auto' }}>
            Showing <strong>{filteredArticles.length}</strong> of {allArticles.length} articles
          </span>
        </div>
      </div>

      {/* News Feed Stream */}
      <div className="news-feed-container">
        {isPending && allArticles.length === 0 ? (
          <div className="news-state-box">
            <RefreshCw size={24} className="animate-spin text-muted" />
            <h3>Connecting to Live Exchange Feed</h3>
            <p>Retrieving latest corporate announcements and earnings results...</p>
          </div>
        ) : error && allArticles.length === 0 ? (
          <div className="news-state-box">
            <h3>Unable to Load Live News</h3>
            <p>{(error as Error).message}</p>
            <button
              type="button"
              className="button button-primary"
              style={{ marginTop: '12px' }}
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </div>
        ) : filteredArticles.length === 0 ? (
          <div className="news-state-box">
            <Filter size={24} className="text-muted" />
            <h3>No Announcements Match Your Filters</h3>
            <p>Try broadening your search query, sentiment, or category selection.</p>
          </div>
        ) : (
          filteredArticles.map(article => {
            const sentiment = article.news_object?.overall_sentiment || 'neutral';
            const isCopied = copiedId === article.article_id;

            return (
              <article
                key={article.article_id}
                className={`news-card news-card--${sentiment}`}
              >
                <div className="news-card-header">
                  <div className="news-card-stock-info">
                    <button
                      type="button"
                      className="news-symbol-btn"
                      onClick={() => handleFilterStock(article)}
                      title={`Filter by ${article.sm_symbol || article.stock_name} (2-Year History)`}
                    >
                      {article.sm_symbol || 'CORP'}
                    </button>
                    <span className="news-company-name">{article.stock_name}</span>
                    {article.metadata?.sector_name && (
                      <span className="news-sector-pill">{article.metadata.sector_name}</span>
                    )}
                    {article.metadata?.marketcap && (
                      <span className="news-sector-pill" style={{ opacity: 0.8 }}>
                        {article.metadata.marketcap}
                      </span>
                    )}
                  </div>

                  <div className="news-card-right-meta">
                    <span className={`sentiment-tag sentiment-tag--${sentiment}`}>
                      {sentiment === 'positive' ? (
                        <TrendingUp size={12} />
                      ) : sentiment === 'negative' ? (
                        <TrendingDown size={12} />
                      ) : (
                        <Minus size={12} />
                      )}
                      {sentiment}
                    </span>
                    <span className="news-time-ago" title={formatFullDate(article.publish_date)}>
                      <Clock size={11} style={{ display: 'inline', marginRight: '3px' }} />
                      {formatTimeAgo(article.publish_date)}
                    </span>
                  </div>
                </div>

                <h2 className="news-headline">{article.news_object?.title}</h2>

                {article.news_object?.text && (
                  <p className="news-summary">{article.news_object.text}</p>
                )}

                <div className="news-card-footer">
                  <span className="news-subcat-badge">
                    {article.sub_category ? article.sub_category.replaceAll('-', ' ') : 'General'}
                  </span>

                  <div className="news-card-actions">
                    <button
                      type="button"
                      className="news-action-btn"
                      onClick={() => handleFilterStock(article)}
                      title="Load 2-year filing history for this stock"
                    >
                      <Building2 size={11} /> Stock History
                    </button>
                    <button
                      type="button"
                      className="news-action-btn"
                      onClick={() => handleCopy(article)}
                      title="Copy summary to clipboard"
                    >
                      {isCopied ? <Check size={11} color="#10b981" /> : <Copy size={11} />}
                      {isCopied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              </article>
            );
          })
        )}

        {/* Load More Button */}
        {allArticles.length > 0 && (
          <button
            type="button"
            className="news-load-more-btn"
            onClick={handleLoadMore}
            disabled={isFetching}
          >
            <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
            {isFetching ? 'Loading Earlier Filings...' : 'Load Earlier Announcements'}
          </button>
        )}
      </div>
    </div>
  );
}

export default NewsTab;
