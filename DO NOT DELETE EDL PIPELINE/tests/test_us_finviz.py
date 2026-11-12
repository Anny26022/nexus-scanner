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
        self.assertEqual(len(data["news"]), 1)
        self.assertEqual(data["news"][0]["title"], "NVDA beats revenue estimates")
        self.assertEqual(data["news"][0]["source"], "Reuters")
        self.assertEqual(len(data["insiders"]), 1)
        self.assertEqual(data["insiders"][0]["name"], "Huang Jen Hsun")
        self.assertEqual(data["insiders"][0]["transaction"], "Sale")

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


if __name__ == "__main__":
    unittest.main()
