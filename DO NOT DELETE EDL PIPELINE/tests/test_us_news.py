"""US news from Dhan's article endpoint, written as India's market_news files."""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "src", ROOT, ROOT / "tests"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from edl_pipeline.markets.us import dhan, news  # noqa: E402

ARTICLE = {'id': 56737446, 'articletitle': 'GameStop shares steady as StoneX initiates Buy rating at $33',
           'summary': 'GameStop shares traded flat.', 'pubdate': '2026-11-20T16:24:14.272Z', 'category': 'companies',
           'slug': 'gamestop-shares-steady-stonex-initiates-buy-rating-33', 'isin': 'US36467W1099'}


def answer(status=200, articles=(ARTICLE,)):
    response = mock.Mock(status_code=status)
    response.json.return_value = {'data': {'latest': list(articles), 'next': []}}
    response.raise_for_status = mock.Mock(side_effect=None if status == 200 else RuntimeError(status))
    return response


class NewsTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def test_articles_become_indias_rows_with_their_link(self):
        post = mock.Mock(return_value=answer())
        self.assertEqual(news.rows(news.fetch('US36467W1099', post=post)), [{
            'Title': ARTICLE['articletitle'], 'Summary': 'GameStop shares traded flat.', 'PublishDate': 1795191854272,
            'Source': 'companies', 'Url': 'https://scanx.trade/stock-market-news/companies/gamestop-shares-steady-stonex-initiates-buy-rating-33/56737446'}])
        self.assertEqual(post.call_args.kwargs['json'], {'isin': 'US36467W1099', 'count': 50})

    def test_each_stock_gets_a_file_and_a_rate_limit_stops_the_rest(self):
        records = [{'symbol': 'GME', 'isin': 'US36467W1099'}, {'symbol': 'NONE', 'isin': 'US0'}, {'symbol': 'NOISIN'}]
        post = mock.Mock(side_effect=[answer(), answer(articles=())])
        counts = news.refresh(records, self.root, interval=0, workers=1, post=post)
        self.assertEqual((counts['with_news'], counts['empty'], counts['skipped']), (1, 1, 1))
        saved = json.loads((self.root / 'market_news' / 'GME_news.json').read_text())
        self.assertEqual((saved['Symbol'], saved['ISIN'], len(saved['News'])), ('GME', 'US36467W1099', 1))
        post = mock.Mock(side_effect=[answer(status=429), answer()])
        counts = news.refresh([{'symbol': 'A', 'isin': '1'}, {'symbol': 'B', 'isin': '2'}], self.root, interval=0, workers=1, post=post)
        self.assertTrue(counts['throttled'])
        self.assertEqual(post.call_count, 1)

    def test_the_chart_builder_reads_the_files_as_market_news(self):
        import build_chart_artifacts
        news.refresh([{'symbol': 'GME', 'isin': 'US36467W1099'}], self.root, interval=0, workers=1, post=mock.Mock(return_value=answer()))
        events = build_chart_artifacts._market_news(self.root, '2026-11-20')
        self.assertEqual(events['GME'][0]['date'], '2026-11-20')
        self.assertEqual(events['GME'][0]['headline'], ARTICLE['articletitle'])
        self.assertEqual(build_chart_artifacts._market_news(self.root, '2026-11-19'), {})  # never before it was published


if __name__ == '__main__':
    unittest.main()
