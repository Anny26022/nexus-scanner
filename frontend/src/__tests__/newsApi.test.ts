import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchLiveNews } from '../api/newsApi';

describe('newsApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches page 0 live news correctly', async () => {
    const mockArticles = [
      {
        article_id: 101,
        article_slug: 'reliance-q1',
        article_cat: 'companies',
        article_subcat: 'earnings',
        category: 'companies',
        sub_category: 'earnings-financial-results',
        publish_date: 1792430000000,
        stock_name: 'Reliance Industries Ltd',
        isin_code: 'INE002A01018',
        sm_symbol: 'RELIANCE',
        news_object: {
          title: 'Reliance Q1 Profit Up 12%',
          text: 'Net profit rose to ₹19,000 Cr.',
          overall_sentiment: 'positive' as const,
        },
      },
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        data: {
          latest_news: mockArticles,
        },
      }),
    }));

    const result = await fetchLiveNews();
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].sm_symbol).toBe('RELIANCE');
    expect(result.articles[0].news_object.overall_sentiment).toBe('positive');
    expect(result.firstTs).toBe(1792430000000);
    expect(result.hasMore).toBe(true);
  });

  it('fetches paginated next_news when pageNo > 0', async () => {
    const mockArticles = [
      {
        article_id: 102,
        article_slug: 'tcs-contract',
        article_cat: 'companies',
        article_subcat: 'orders',
        category: 'companies',
        sub_category: 'operational-updates',
        publish_date: 1792420000000,
        stock_name: 'Tata Consultancy Services Ltd',
        isin_code: 'INE467B01029',
        sm_symbol: 'TCS',
        news_object: {
          title: 'TCS Wins $500M Deal',
          text: 'Major multi-year cloud contract signed.',
          overall_sentiment: 'positive' as const,
        },
      },
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        data: {
          next_news: mockArticles,
        },
      }),
    }));

    const result = await fetchLiveNews({
      pageNo: 1,
      firstNewsTimeStamp: 1792430000000,
      lastNewsTimeStamp: 1792425000000,
    });

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].sm_symbol).toBe('TCS');
  });

  it('handles API errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    await expect(fetchLiveNews()).rejects.toThrow('News request failed (HTTP 500)');
  });
});
