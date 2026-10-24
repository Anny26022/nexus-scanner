/** Live market news feed client. */

export interface NewsArticle {
  article_id: number;
  article_slug: string;
  article_cat: string;
  article_subcat: string;
  category: string;
  sub_category: string;
  publish_date: number; // millisecond epoch
  stock_name: string;
  isin_code: string;
  sm_symbol: string;
  nse_scrip_code?: number;
  bse_scrip_code?: number;
  display_symbol?: string;
  news_object: {
    title: string;
    text: string;
    overall_sentiment: 'positive' | 'neutral' | 'negative';
  };
  metadata?: {
    marketcap?: string;
    sector_name?: string;
    cd_mcap?: number;
    cm_custom_symbol?: string;
    isin_code?: string;
    sm_symbol?: string;
    sm_symbol_name?: string;
  };
}

export interface NewsFetchParams {
  stockIsin?: string; // 'ALL' or specific ISIN e.g. 'INE002A01018'
  category?: string;  // 'ALL' or specific
  pageNo?: number;
  limit?: number;     // max 100
  firstNewsTimeStamp?: number;
  lastNewsTimeStamp?: number;
  signal?: AbortSignal;
}

export interface NewsFetchResult {
  articles: NewsArticle[];
  firstTs: number;
  lastTs: number;
  hasMore: boolean;
}

const NEWS_ENDPOINT = 'https://news-live.dhan.co/v2/news/getLiveNews';

export async function fetchLiveNews(params: NewsFetchParams = {}): Promise<NewsFetchResult> {
  const {
    stockIsin = 'ALL',
    category = 'ALL',
    pageNo = 0,
    limit = 50,
    firstNewsTimeStamp = 0,
    lastNewsTimeStamp = 0,
    signal,
  } = params;

  const payload = {
    categories: [category],
    entity_id: '',
    first_news_timeStamp: firstNewsTimeStamp,
    last_news_timeStamp: lastNewsTimeStamp,
    limit: Math.min(limit, 100),
    news_feed_type: 'live',
    page_no: pageNo,
    stock_list: [stockIsin],
  };

  const response = await fetch(NEWS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    throw new Error(`News request failed (HTTP ${response.status})`);
  }

  const json = await response.json();
  const data = json?.data ?? {};
  const rawArticles: NewsArticle[] = (pageNo === 0 ? data.latest_news : data.next_news) || [];

  const firstTs = rawArticles.length > 0 ? rawArticles[0].publish_date : firstNewsTimeStamp;
  const lastTs = rawArticles.length > 0 ? rawArticles[rawArticles.length - 1].publish_date : lastNewsTimeStamp;

  return {
    articles: rawArticles,
    firstTs,
    lastTs,
    hasMore: rawArticles.length > 0,
  };
}
