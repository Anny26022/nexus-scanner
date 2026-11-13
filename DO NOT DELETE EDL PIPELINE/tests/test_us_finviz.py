"""Finviz crawler tests: the theme catalog, the thematic and ownership universes, and each stock's classification.

Standalone (only `edl_pipeline.markets.us.finviz`), so the weekly Finviz sync can run them on its own.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "src", ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import requests  # noqa: E402,F401

from edl_pipeline.markets.us import finviz  # noqa: E402


class FinvizTests(unittest.TestCase):
    def test_extract_screener_json_and_theme_catalog(self):
        sample_html = """
        <html>
        <script>
        window.__DATA__ = {
            "screenerType": "stocks",
            "filters": {
                "filters": [
                    {
                        "key": "theme",
                        "options": [
                            {"value": "artificialintelligence", "label": "Artificial Intelligence"},
                            {"value": "modal", "label": "Upgrade", "isEliteOnly": true}
                        ]
                    },
                    {
                        "key": "subtheme",
                        "options": [
                            {"value": "aicompute", "label": "AI - Compute", "group": "artificialintelligence"}
                        ]
                    }
                ]
            }
        };
        </script>
        </html>
        """
        mock_resp = mock.Mock(status_code=200, text=sample_html)
        mock_session = mock.Mock()
        mock_session.get.return_value = mock_resp

        themes, subthemes = finviz.fetch_theme_catalog(session=mock_session)
        self.assertEqual(len(themes), 1)
        self.assertEqual(themes[0], {"value": "artificialintelligence", "label": "Artificial Intelligence"})
        self.assertEqual(len(subthemes), 1)
        self.assertEqual(subthemes[0], {"value": "aicompute", "label": "AI - Compute", "group": "artificialintelligence"})
        self.assertEqual(finviz.theme_catalog_payload(themes, subthemes), {"themes": [
            {"value": "artificialintelligence", "label": "Artificial Intelligence",
             "subthemes": [{"value": "aicompute", "label": "AI - Compute"}]},
        ]})
        # Finviz's labels sometimes carry double spaces ("Quantum  - Applications").
        catalog = finviz.theme_catalog_payload([{"value": "q", "label": "Quantum Computing"}],
                                               [{"value": "qa", "label": "Quantum  - Applications", "group": "q"}])
        self.assertEqual(catalog["themes"][0]["subthemes"][0]["label"], "Quantum - Applications")

    def test_fetch_tickers_for_filter(self):
        sample_html = '{"totalCount": 2, "data": [{"ticker": "NVDA"}, {"ticker": "AMD"}]}'
        mock_resp = mock.Mock(status_code=200, text=sample_html)
        mock_session = mock.Mock()
        mock_session.get.return_value = mock_resp

        tickers = finviz.fetch_tickers_for_filter("theme_artificialintelligence", session=mock_session, delay=0)
        self.assertEqual(tickers, ["AMD", "NVDA"])

    def test_fetch_news_and_insiders(self):
        sample_html = """
        <table id="news-table">
            <tr class="news-link-container">
                <td>Nov-11-26 10:00AM</td>
                <a href="https://example.com/news1" class="tab-link-news">NVDA beats revenue estimates</a>
                <span class="news-link-right">(Reuters)</span>
            </tr>
        </table>
        <table class="body-table">
            <tr class="insider-row">
                <td><a href="#">Huang Jen Hsun</a></td>
                <td>CEO</td>
                <td>Nov 10</td>
                <td>Sale</td>
                <td>145.00</td>
                <td>50,000</td>
                <td>7,250,000</td>
                <td>800,000</td>
                <td>Nov 11 04:30 PM</td>
            </tr>
        </table>
        """
        mock_resp = mock.Mock(status_code=200, text=sample_html)
        mock_session = mock.Mock()
        mock_session.get.return_value = mock_resp

        data = finviz.fetch_news_and_insiders("NVDA", session=mock_session)
        # Keyed as stock_record reads a stock's thematic entry.
        self.assertEqual(len(data["news_feed"]), 1)
        self.assertEqual(data["news_feed"][0]["title"], "NVDA beats revenue estimates")
        self.assertEqual(data["news_feed"][0]["source"], "Reuters")
        self.assertEqual(len(data["insider_activity"]), 1)
        self.assertEqual(data["insider_activity"][0]["name"], "Huang Jen Hsun")
        self.assertEqual(data["insider_activity"][0]["transaction"], "Sale")
        mock_session.get.return_value = mock.Mock(status_code=503, text="")
        self.assertEqual(finviz.fetch_news_and_insiders("BRK.B", session=mock_session),
                         {"news_feed": [], "insider_activity": []})
        self.assertTrue(mock_session.get.call_args[0][0].endswith("?t=BRK-B"))

    def test_load_and_save_thematic_universe(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "test_thematic.json"
            sample_data = {
                "NVDA": {"primary_theme": "AI", "themes": ["AI", "Semis"], "subthemes": ["AI - Compute"]}
            }
            finviz.save_thematic_universe(file_path, sample_data)
            loaded = finviz.load_thematic_universe(file_path)
            self.assertEqual(loaded, sample_data)

    def test_load_and_save_ownership_universe(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "test_ownership.json"
            sample_data = {
                "NVDA": {
                    "short_float_percent": 1.25, "short_ratio": 1.8,
                    "insider_own_percent": 3.75, "institutional_own_percent": 72.5
                }
            }
            finviz.save_ownership_universe(file_path, sample_data)
            loaded = finviz.load_ownership_universe(file_path)
            self.assertEqual(loaded, sample_data)

    def test_ownership_crawl_keeps_finviz_classification(self):
        # The ownership view's rows have no sector: it comes from the sector shard the row was fetched from.
        row = {"text": {"ticker": "A", "industry": "Diagnostics & Research", "securityType": "Stock"},
               "numbers": {"shortInterestShare": 1.74, "instOwn": 95.73}}
        html = '<script>window.__DATA__ = {"screenerType": "stocks", "filters": {"filters": []}, "data": {"rows": %s, "totalCount": 1}};</script>' % json.dumps([row])
        session = mock.Mock()
        session.get.return_value = mock.Mock(status_code=200, text=html)
        with mock.patch.object(finviz, 'SECTOR_SHARDS', ['sec_healthcare,exch_nyse']):
            universe = finviz.crawl_ownership_universe(session=session, workers=1, log=lambda *_: None)
        self.assertEqual(universe["A"]["finviz_sector"], "Healthcare")
        self.assertEqual(universe["A"]["finviz_industry"], "Diagnostics & Research")
        self.assertEqual(universe["A"]["security_type"], "Stock")
        self.assertEqual(universe["A"]["short_float_percent"], 1.74)


    def test_labels_are_normalized_in_catalog_and_universe(self):
        self.assertEqual(finviz.normalize_label("Autonomous  - Vehicles "), "Autonomous - Vehicles")
        self.assertEqual(finviz.normalize_label("Hardware - Gaming & Immersive Pheriperals"),
                         "Hardware - Gaming & Immersive Peripherals")
        html = ('<script>window.__DATA__ = {"screenerType": "stocks", "filters": {"filters": ['
                '{"key": "theme", "options": [{"value": "q", "label": "Quantum  Computing"}]},'
                '{"key": "subtheme", "options": [{"value": "qa", "label": "Quantum  - Applications", "group": "q"}]}'
                ']}};</script>')
        session = mock.Mock()
        session.get.side_effect = lambda url, **_: mock.Mock(
            status_code=200, text=html if "f=" not in url else '{"totalCount": 1, "x": [{"ticker": "BRK-B"}]}')
        universe = finviz.crawl_thematic_universe(session=session, delay=0, log=lambda *_: None)
        self.assertEqual(universe, {"BRK.B": {"themes": ["Quantum Computing"], "subthemes": ["Quantum - Applications"],
                                              "primary_theme": "Quantum Computing"}})

    def test_finviz_class_share_tickers_use_pipeline_symbols(self):
        self.assertEqual(finviz.canonical_symbol("BRK-B"), "BRK.B")
        self.assertEqual(finviz.canonical_symbol("NVDA"), "NVDA")
        row = {"text": {"ticker": "BRK-B", "industry": "Insurance - Diversified"}, "numbers": {}}
        html = '<script>window.__DATA__ = {"screenerType": "stocks", "filters": {"filters": []}, "data": {"rows": %s, "totalCount": 1}};</script>' % json.dumps([row])
        session = mock.Mock()
        session.get.return_value = mock.Mock(status_code=200, text=html)
        with mock.patch.object(finviz, 'SECTOR_SHARDS', ['sec_financial,exch_nyse']):
            universe = finviz.crawl_ownership_universe(session=session, workers=1, log=lambda *_: None)
        self.assertEqual(list(universe), ["BRK.B"])

    def test_failed_thematic_fetch_raises_instead_of_returning_empty(self):
        session = mock.Mock()
        session.get.return_value = mock.Mock(status_code=503, text="")
        with self.assertRaises(finviz.FinvizFetchError):
            finviz.fetch_tickers_for_filter("theme_x", session=session, delay=0)
        with self.assertRaises(finviz.FinvizFetchError):  # empty catalog
            finviz.crawl_thematic_universe(session=session, delay=0, log=lambda *_: None)
        session.get.side_effect = requests.ConnectionError("down")
        with self.assertRaises(finviz.FinvizFetchError):
            finviz.fetch_tickers_for_filter("theme_x", session=session, delay=0)

    def test_block_page_or_short_thematic_filter_raises(self):
        session = mock.Mock()
        # A 200 page without totalCount (block page, layout change) is not an empty filter.
        session.get.return_value = mock.Mock(status_code=200, text="<html>Too many requests</html>")
        with self.assertRaises(finviz.FinvizFetchError):
            finviz.fetch_tickers_for_filter("theme_x", session=session, delay=0)
        # Fewer tickers than Finviz reports (a page cut short) raises instead of truncating the theme.
        session.get.return_value = mock.Mock(status_code=200, text='{"totalCount": 3, "data": [{"ticker": "NVDA"}]}')
        with self.assertRaises(finviz.FinvizFetchError):
            finviz.fetch_tickers_for_filter("theme_x", session=session, delay=0)
        # A genuinely empty filter still reports totalCount 0 and is accepted.
        session.get.return_value = mock.Mock(status_code=200, text='{"totalCount": 0, "data": []}')
        self.assertEqual(finviz.fetch_tickers_for_filter("theme_x", session=session, delay=0), [])

    def test_failed_or_short_ownership_shard_aborts_crawl(self):
        html = '<script>window.__DATA__ = {"screenerType": "stocks", "filters": {"filters": []}, "data": {"rows": [], "totalCount": 25}};</script>'
        session = mock.Mock()
        session.get.return_value = mock.Mock(status_code=200, text=html)
        with mock.patch.object(finviz, 'SECTOR_SHARDS', ['sec_energy']):
            with self.assertRaises(finviz.FinvizFetchError):  # 0 of 25 rows
                finviz.crawl_ownership_universe(session=session, workers=1, delay=0, log=lambda *_: None)
            session.get.return_value = mock.Mock(status_code=500, text="")
            with self.assertRaises(finviz.FinvizFetchError):
                finviz.crawl_ownership_universe(session=session, workers=1, delay=0, log=lambda *_: None)

    def test_check_coverage_keeps_committed_file_on_partial_crawl(self):
        previous = {str(i): {} for i in range(100)}
        with self.assertRaises(finviz.FinvizFetchError):
            finviz.check_coverage({}, previous, "x")
        with self.assertRaises(finviz.FinvizFetchError):
            finviz.check_coverage({str(i): {} for i in range(50)}, previous, "x")
        finviz.check_coverage({str(i): {} for i in range(95)}, previous, "x")
        finviz.check_coverage({"A": {}}, {}, "x")

    def test_workers_must_be_positive(self):
        self.assertEqual(finviz._positive_int("3"), 3)
        for bad in ("0", "-2"):
            with self.assertRaises(finviz.argparse.ArgumentTypeError):
                finviz._positive_int(bad)


if __name__ == "__main__":
    unittest.main()
