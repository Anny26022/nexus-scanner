import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from build_ipo_screener_artifact import (
    _provider_by_symbol,
    _provider_details_by_symbol,
    _provider_catalogue_data,
    _scanx_by_symbol,
    build_ipo_catalog,
)


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
        stocks = [{"symbol": symbol, "default_screener_eligible": True} for symbol in ("NEW", "OTHER")]
        listings = [{"SYMBOL": symbol, "SERIES": "EQ", "DATE OF LISTING": "25-SEP-2026"} for symbol in ("NEW", "OTHER")]
        decoded = {
            "NEW": {
                "id": "NSE_NEW", "price_band_high": 120, "issue_size_cr": 50,
                "retail_subscription": 3.4, "qib_subscription": 7.8,
                "listing_price": 135, "listing_gain_pct": 12.5,
                "listing_date_iso": "2026-09-25",
            }
        }
        records, _ = build_ipo_catalog(stocks, listings, date(2026, 9, 28), decoded)
        other = next(row for row in records if row["symbol"] == "OTHER")
        self.assertIsNone(other["issue_price"])
        self.assertIsNone(other["provider"])
        matched = next(row for row in records if row["symbol"] == "NEW")
        self.assertEqual(matched["issue_price"], 120)
        self.assertEqual(matched["retail_subscription_multiple"], 3.4)
        self.assertEqual(matched["provider"]["listing_price"], 135)

        decoded["NEW"]["listing_date_iso"] = "2005-09-25"
        records, _ = build_ipo_catalog(stocks, listings, date(2026, 9, 28), decoded)
        mismatched = next(row for row in records if row["symbol"] == "NEW")
        self.assertIsNone(mismatched["issue_price"])
        self.assertIsNone(mismatched["provider"])

    def test_retains_all_fetched_provider_groups_in_catalogue_payload(self):
        provider = _provider_catalogue_data({
            "schema_version": 2, "source": "provider", "available": True, "recent_feed_available": True,
            "fetched_at": "2026-10-04T00:00:00Z", "records": [{"id": "NSE_NEW"}],
            "feeds": {"open": {"ipos": [{"id": "NSE_OPEN"}]}},
            "analytics": {"year_summary": {"year": "2026"}},
            "details": {"NSE_NEW": {"data": {"timeline": []}}}, "errors": ["example error"],
        })
        self.assertEqual(provider["listed_archive"][0]["id"], "NSE_NEW")
        self.assertEqual(provider["feeds"]["open"]["ipos"][0]["id"], "NSE_OPEN")
        self.assertEqual(provider["errors"], ["example error"])
        self.assertIn("year_summary", provider["analytics"])
        self.assertIn("NSE_NEW", provider["details"])

    def test_attaches_matching_anchor_lockin_calendar(self):
        stocks = [{"symbol": "NEW", "name": "New Ltd", "default_screener_eligible": True}]
        listings = [{"SYMBOL": "NEW", "SERIES": "EQ", "DATE OF LISTING": "25-SEP-2026"}]
        lockins = {"NEW": [
            {"listing_date": "2026-09-25", "unlock_date": "2026-12-25", "tranche": 30},
            {"listing_date": "2026-09-25", "unlock_date": "2027-03-25", "tranche": 90},
            {"listing_date": "2025-09-25", "unlock_date": "2025-12-25", "tranche": 30},
            {"listing_date": "25-SEP-2026", "unlock_date": "25-SEP-2025", "tranche": 30},
            {"listing_date": "25-SEP-2026", "unlock_date": "01-OCT-2026", "tranche": 30},
            {"listing_date": "25-SEP-2026", "unlock_date": "invalid", "tranche": 30},
        ]}
        records, _ = build_ipo_catalog(stocks, listings, date(2026, 9, 28), anchor_lockins=lockins)
        self.assertIsNone(records[0]["anchor_lock_in_end"])
        self.assertEqual(records[0]["next_anchor_lock_in_date"], "2026-10-01")
        self.assertEqual(len(records[0]["anchor_lock_in_calendar"]), 5)
        records, _ = build_ipo_catalog(stocks, listings, None, anchor_lockins=lockins)
        self.assertIsNone(records[0]["next_anchor_lock_in_date"])
        self.assertEqual(len(records[0]["anchor_lock_in_calendar"]), 5)

    def test_archived_terms_and_details_survive_unavailable_live_feed(self):
        issue = {"id": "NSE_NEW", "symbol": "NEW", "exchange": "NSE", "ipo_type": "MAINBOARD",
                 "listing_date_iso": "2026-09-25", "price_band_high": 120}
        payload = {"available": False, "records": [issue], "details": {"NSE_NEW": {"data": {"issue": {"price": 120}}}}}
        self.assertEqual(_provider_by_symbol(payload)["NEW"], issue)
        self.assertEqual(_provider_details_by_symbol(payload)["NEW"], {"issue": {"price": 120}})
        self.assertFalse(any(_provider_details_by_symbol({**payload, "details": {}}).values()))

    def test_scanx_enrichment_requires_exact_nse_identity_and_listing_date(self):
        stocks = [{"symbol": "NEW", "isin": "INE1", "default_screener_eligible": True}]
        listings = [{"SYMBOL": "NEW", "SERIES": "EQ", "DATE OF LISTING": "25-SEP-2026"}]
        payload = {
            "records": [{
                "ipo_symbol_name": "NEW", "ipo_isin": "INE1", "ipo_listed_date": "2026-09-25T17:00",
                "ipo_issue_price": 100, "seo_symbol": "new-ltd",
            }],
            "details": {"new-ltd": {"data": {
                "symbol": "NEW", "isin": "INE1", "listing_date": "2026-09-25 17:00:00",
                "issue_size": 500_000_000,
                "catsubscription_data": {"retail_times": 3.2, "qib_times": 7.5},
            }}},
        }
        scanx = _scanx_by_symbol(payload)
        records, _ = build_ipo_catalog(
            stocks, listings, date(2026, 9, 28),
            provider={"NEW": {"listing_date_iso": "2026-09-25", "price_band_high": None}},
            scanx=scanx,
        )
        self.assertEqual(records[0]["issue_price"], 100)
        self.assertEqual(records[0]["offer_structure"]["issue_size_crore"], 50)
        self.assertEqual(records[0]["retail_subscription_multiple"], 3.2)
        self.assertEqual(records[0]["scanx"]["details"]["isin"], "INE1")

        payload["records"][0]["ipo_listed_date"] = "2025-09-25"
        payload["details"] = {}
        records, _ = build_ipo_catalog(stocks, listings, date(2026, 9, 28), scanx=_scanx_by_symbol(payload))
        self.assertIsNone(records[0]["scanx"])
        self.assertIsNone(records[0]["issue_price"])

    def test_catalogue_preserves_full_scanx_source_payload(self):
        scanx = {
            "schema_version": 1, "source": "ScanX public IPO API", "available": True,
            "records": [{"ipo_symbol_name": "NEW"}], "feeds": {"open": {"data": [{"symbol": "NEW"}]}},
            "details": {"new-ltd": {"data": {"financials": []}}}, "coverage": {"listed_records": 1},
            "errors": [],
        }
        result = _provider_catalogue_data({}, scanx)["scanx"]
        self.assertTrue(result["available"])
        self.assertEqual(result["listed_archive"][0]["ipo_symbol_name"], "NEW")
        self.assertIn("new-ltd", result["details"])


if __name__ == "__main__":
    unittest.main()
