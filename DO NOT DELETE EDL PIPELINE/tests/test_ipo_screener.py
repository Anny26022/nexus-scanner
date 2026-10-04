import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from build_ipo_screener_artifact import _provider_catalogue_data, build_ipo_catalog


class IpoScreenerTests(unittest.TestCase):
    def test_uses_official_eq_listing_dates_and_never_invents_issue_terms(self):
        stocks = [{
            "symbol": "NEW", "name": "New Ltd", "isin": "INE1", "security_id": "101",
            "default_screener_eligible": True, "close": 125, "market_cap_crore": 800,
            "sector": "Industry", "industry": "Manufacturing", "rupee_volume": 2_000_000,
        }]
        listings = [
            {"SYMBOL": " NEW ", " SERIES": " EQ ", " DATE OF LISTING": "25-SEP-2026"},
            {"SYMBOL": "SME", " SERIES": " SM ", " DATE OF LISTING": "25-SEP-2026"},
            {"SYMBOL": "PENDING", " SERIES": " EQ ", " DATE OF LISTING": "24-SEP-2026"},
        ]
        records, pending = build_ipo_catalog(stocks, listings, date(2026, 9, 28))
        self.assertEqual(records[0]["symbol"], "NEW")
        self.assertEqual(records[0]["listing_age_calendar_days"], 3)
        self.assertEqual(records[0]["issue_price"], None)
        self.assertEqual(records[0]["anchor_lock_in_end"], None)
        self.assertEqual(pending, [{"symbol": "PENDING", "listing_date": "2026-09-24", "reason": "pending_canonical_enrichment"}])

    def test_adds_permitted_provider_enrichment_only_for_matching_nse_symbol(self):
        stocks = [{"symbol": "NEW", "name": "New Ltd", "default_screener_eligible": True}]
        listings = [{"SYMBOL": "NEW", "SERIES": "EQ", "DATE OF LISTING": "25-SEP-2026"}]
        decoded = {
            "NEW": {
                "id": "NSE_NEW", "price_band_high": 120, "issue_size_cr": 50,
                "retail_subscription": 3.4, "qib_subscription": 7.8,
                "listing_price": 135, "listing_gain_pct": 12.5,
                "listing_date_iso": "2026-09-25",
            }
        }
        records, _ = build_ipo_catalog(stocks, listings, date(2026, 9, 28), decoded)
        self.assertEqual(records[0]["issue_price"], 120)
        self.assertEqual(records[0]["retail_subscription_multiple"], 3.4)
        self.assertEqual(records[0]["provider"]["listing_price"], 135)

        decoded["NEW"]["listing_date_iso"] = "2005-09-25"
        records, _ = build_ipo_catalog(stocks, listings, date(2026, 9, 28), decoded)
        self.assertIsNone(records[0]["issue_price"])
        self.assertIsNone(records[0]["provider"])

    def test_retains_all_fetched_provider_groups_in_catalogue_payload(self):
        provider = _provider_catalogue_data({
            "schema_version": 2, "source": "provider", "available": True, "recent_feed_available": True,
            "fetched_at": "2026-10-04T00:00:00Z", "records": [{"id": "NSE_NEW"}],
            "feeds": {"open": {"ipos": [{"id": "NSE_OPEN"}]}},
            "analytics": {"year_summary": {"year": "2026"}},
            "details": {"NSE_NEW": {"data": {"timeline": []}}}, "errors": [],
        })
        self.assertEqual(provider["listed_archive"][0]["id"], "NSE_NEW")
        self.assertIn("year_summary", provider["analytics"])
        self.assertIn("NSE_NEW", provider["details"])

    def test_attaches_matching_anchor_lockin_calendar(self):
        stocks = [{"symbol": "NEW", "name": "New Ltd", "default_screener_eligible": True}]
        listings = [{"SYMBOL": "NEW", "SERIES": "EQ", "DATE OF LISTING": "25-SEP-2026"}]
        lockins = {"NEW": [
            {"listing_date": "2026-09-25", "unlock_date": "2026-12-25", "tranche": 30},
            {"listing_date": "2026-09-25", "unlock_date": "2027-03-25", "tranche": 90},
            {"listing_date": "2025-09-25", "unlock_date": "2025-12-25", "tranche": 30},
        ]}
        records, _ = build_ipo_catalog(stocks, listings, date(2026, 9, 28), anchor_lockins=lockins)
        self.assertIsNone(records[0]["anchor_lock_in_end"])
        self.assertEqual(records[0]["next_anchor_lock_in_date"], "2026-12-25")
        self.assertEqual(len(records[0]["anchor_lock_in_calendar"]), 2)


if __name__ == "__main__":
    unittest.main()
