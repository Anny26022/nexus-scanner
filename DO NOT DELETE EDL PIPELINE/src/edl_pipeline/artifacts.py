"""Artifact names and stage definitions for the pipeline runner."""

from .schemas import REQUIRED_FINAL_FIELDS
from .validators import ArtifactSpec

INTERMEDIATE_FILES = [
    "master_isin_map.json",
    "dhan_data_response.json",
    "mainboard_scanx_data.json",
    "fundamental_data.json",
    "advanced_indicator_data.json",
    "all_company_announcements.json",
    "nse_corporate_actions.json",
    "nse_corporate_action_adjustments.json",
    "upcoming_earnings_events.json",
    "earnings_calendar.json",
    "history_earnings_events.json",
    "nse_asm_list.json",
    "nse_gsm_list.json",
    "bulk_block_deals.json",
    "upper_circuit_stocks.json",
    "lower_circuit_stocks.json",
    "incremental_price_bands.json",
    "complete_price_bands.json",
    "nse_equity_list.csv",
    "all_stocks_fundamental_analysis.json",
    "sector_analytics.json",
    "market_breadth.csv",
    "etf_data_response.json",
    "corporate_action_ledger.json",
    "shareholding_history.json",
    "filing_history.json",
    "quarterly_financial_history.json",
    "nse_delivery_data.json",
    "eod2_ohlcv_import_report.json",
    "nse_daily_ohlcv_report.json",
    "ipo_screener.json",
    "ipo_provider_data.json",
    "scanx_ipo_data.json",
]

INTERMEDIATE_DIRS = [
    "company_filings",
    "market_news",
]

FILES_TO_COMPRESS = {
    "all_stocks_fundamental_analysis.json": "all_stocks_fundamental_analysis.json.gz",
    "sector_analytics.json": "sector_analytics.json.gz",
    "market_breadth.csv": "market_breadth.json.gz",
    "market_breadth_v2.json": "market_breadth_v2.json.gz",
    "breadth_universe_snapshot.json": "breadth_universe_snapshot.json.gz",
    "all_indices_history_v2.json": "all_indices_history_v2.json.gz",
    "sector_breadth_v2.json": "sector_breadth_v2.json.gz",
    "market_breadth_contributions_v2.json": "market_breadth_contributions_v2.json.gz",
    "corporate_action_ledger.json": "corporate_action_ledger.json.gz",
    "nse_corporate_actions.json": "nse_corporate_actions.json.gz",
    "nse_corporate_action_adjustments.json": "nse_corporate_action_adjustments.json.gz",
    "nse_fno_ban.json": "nse_fno_ban.json.gz",
    "earnings_calendar.json": "earnings_calendar.json.gz",
    "rs_rating_daily.json": "rs_rating_daily.json.gz",
    "ipo_screener.json": "ipo_screener.json.gz",
    "shareholding_history.json": "shareholding_history.json.gz",
    "filing_history.json": "filing_history.json.gz",
    "quarterly_financial_history.json": "quarterly_financial_history.json.gz",
    # Raw NSE SME coverage is retained separately; it is never part of the
    # canonical scanner universe.
    "sme_market_data.json": "sme_market_data.json.gz",
}

# The full refresh generates and validates these alongside the stock snapshot.
# A no-OHLCV diagnostic run skips them and is never published.
OHLCV_DERIVED_SCRIPT = "process_mbi_market_breadth.py"
OHLCV_DERIVED_FILES = frozenset(
    {
        "market_breadth_v2.json",
        "breadth_universe_snapshot.json",
        "all_indices_history_v2.json",
        "sector_breadth_v2.json",
        "market_breadth_contributions_v2.json",
    }
)
OHLCV_DERIVED_FINAL_PATHS = frozenset(
    f"{path}.gz" for path in OHLCV_DERIVED_FILES
)

PHASE2_SCRIPTS = [
    "fetch_company_filings.py",
    "fetch_new_announcements.py",
    "fetch_advanced_indicators.py",
    "fetch_market_news.py",
    "fetch_nse_corporate_actions.py",
    "fetch_corporate_actions.py",
    "fetch_bse_earnings_calendar.py",
    "fetch_surveillance_lists.py",
    "fetch_circuit_stocks.py",
    "fetch_bulk_block_deals.py",
    "fetch_incremental_price_bands.py",
    "fetch_complete_price_bands.py",
    "fetch_nse_delivery_data.py",
    "fetch_nse_fno_ban.py",
    "fetch_all_indices.py",
]

REQUIRED_PHASE2_SCRIPTS = frozenset(
    {
        "fetch_all_indices.py",
        "fetch_nse_delivery_history.py",
        "fetch_nse_corporate_actions.py",
    }
)

# Official delivery history supplies observed per-security sessions for gap
# repair. Prepare that ledger in this lane before stock history is checked.
# The latest official NSE session must be applied before the incremental Dhan
# backfill.  Keeping this chain in one lane prevents concurrent writers from
# touching the OHLCV cache while independent enrichment fetches run alongside
# it.
OHLCV_FETCH_LANE = (
    "fetch_nse_delivery_history.py",
    "import_eod2_ohlcv.py",
    "fetch_nse_delivery_data.py",
    "apply_nse_daily_ohlcv.py",
    "fetch_all_ohlcv.py",
)

PHASE4_SCRIPTS = [
    "advanced_metrics_processor.py",
    "process_earnings_performance.py",
    "enrich_fno_data.py",
    "enrich_delivery_data.py",
    "enrich_surveillance_status.py",
    "process_market_breadth.py",
    "process_historical_market_breadth.py",
    # This produces breadth_universe_snapshot.json, which is the fixed
    # universe required to rank relative strength.
    OHLCV_DERIVED_SCRIPT,
    "build_rs_ratings.py",
    "build_shareholding_history.py",
    "add_corporate_events.py",
    "build_corporate_action_ledger.py",
    "enrich_published_fields.py",
    "standardize_stock_artifact.py",
]

# These consumers read the canonical artifact and must run after its final
# standardisation, without making another mutation to it.
POST_STANDARDIZATION_SCRIPTS = [
    "build_filing_history_artifact.py",
    "build_quarterly_financial_ledger.py",
    "fetch_ipo_provider_data.py",
    "fetch_scanx_ipo_data.py",
    "build_ipo_screener_artifact.py",
    # Capture temporary news/filings before compression and cleanup.
    "build_chart_artifacts.py",
]

# This runs after the canonical artifact is compressed, so standardisation
# remains the final mutation of the public stock snapshot.
SCANNER_HISTORY_SCRIPT = "snapshot_screener_context.py"

OPTIONAL_SCRIPTS = [
    "fetch_etf_data.py",
]

SCRIPT_OUTPUT_SPECS = {
    "fetch_dhan_data.py": [
        ArtifactSpec("dhan_data_response.json", "json", min_count=1),
        ArtifactSpec("master_isin_map.json", "json", min_count=1, required_fields=("Symbol", "ISIN", "Sid")),
    ],
    "fetch_fundamental_data.py": [
        ArtifactSpec("fundamental_data.json", "json", min_count=1),
    ],
    "reconcile_nse_equity_universe.py": [
        ArtifactSpec(
            "nse_universe_reconciliation.json", "json",
            required_fields=("available", "source", "as_of_date", "pending_scanx_enrichment", "alert_count"),
        ),
    ],
    "fetch_company_filings.py": [
        ArtifactSpec("company_filings", "dir", min_count=1),
    ],
    "build_filing_history_artifact.py": [
        ArtifactSpec("filing_history.json", "json", min_count=1, required_fields=("source", "coverage", "records")),
    ],
    "build_quarterly_financial_ledger.py": [
        ArtifactSpec("quarterly_financial_history.json", "json", min_count=0, required_fields=("source", "coverage", "records")),
    ],
    "build_chart_artifacts.py": [
        ArtifactSpec("chart_artifacts", "dir", min_count=1),
    ],
    "fetch_new_announcements.py": [
        ArtifactSpec("all_company_announcements.json", "json", min_count=0),
    ],
    "fetch_advanced_indicators.py": [
        ArtifactSpec("advanced_indicator_data.json", "json", min_count=0),
    ],
    "fetch_market_news.py": [
        ArtifactSpec("market_news", "dir", min_count=1),
    ],
    "fetch_nse_corporate_actions.py": [
        ArtifactSpec("nse_corporate_actions.json", "json", min_count=1, required_fields=("source", "range", "actions")),
        ArtifactSpec("nse_corporate_action_adjustments.json", "json", min_count=1, required_fields=("source", "range", "revision", "actions")),
    ],
    "fetch_corporate_actions.py": [
        ArtifactSpec("upcoming_earnings_events.json", "json", min_count=0),
        ArtifactSpec("history_earnings_events.json", "json", min_count=0),
    ],
    "fetch_bse_earnings_calendar.py": [
        ArtifactSpec("earnings_calendar.json", "json", min_count=1, required_fields=("source", "fetched_at", "events", "available")),
    ],
    "fetch_surveillance_lists.py": [
        ArtifactSpec("nse_asm_list.json", "json", min_count=0),
        ArtifactSpec("nse_gsm_list.json", "json", min_count=0),
    ],
    "fetch_circuit_stocks.py": [
        ArtifactSpec("upper_circuit_stocks.json", "json", min_count=0),
        ArtifactSpec("lower_circuit_stocks.json", "json", min_count=0),
    ],
    "fetch_bulk_block_deals.py": [
        ArtifactSpec("bulk_block_deals.json", "json", min_count=0),
    ],
    "fetch_incremental_price_bands.py": [
        ArtifactSpec("incremental_price_bands.json", "json", min_count=0),
    ],
    "fetch_complete_price_bands.py": [
        ArtifactSpec("complete_price_bands.json", "json", min_count=1),
    ],
    "fetch_nse_delivery_data.py": [
        ArtifactSpec("nse_delivery_data.json", "json", min_count=1, required_fields=("source", "as_of_date", "retrieved_at", "records", "ohlcv_records")),
    ],
    "snapshot_screener_context.py": [
        ArtifactSpec("scanner_history_data", "dir", min_count=1),
    ],
    "fetch_nse_fno_ban.py": [
        ArtifactSpec("nse_fno_ban.json", "json", required_fields=("source", "available", "trade_date", "symbols")),
    ],
    "build_rs_ratings.py": [
        ArtifactSpec("rs_rating_daily.json", "json", required_fields=("source", "as_of_date", "ratings")),
    ],
    "fetch_all_indices.py": [
        ArtifactSpec("all_indices_list.json", "json", min_count=1),
    ],
    "fetch_sme_data.py": [
        ArtifactSpec("sme_market_data.json", "json", min_count=1, required_fields=("Symbol", "Series")),
    ],
    "filter_mainboard_universe.py": [
        ArtifactSpec(
            "mainboard_universe_report.json", "json",
            required_fields=("raw_scanx_count", "excluded_sme_count", "mainboard_count", "mainboard_scanx_count"),
        ),
    ],
    "fetch_all_ohlcv.py": [
        ArtifactSpec("ohlcv_data", "dir", min_count=1),
    ],
    "apply_nse_daily_ohlcv.py": [
        ArtifactSpec("nse_daily_ohlcv_report.json", "json", required_fields=("available",)),
    ],
    "import_eod2_ohlcv.py": [
        ArtifactSpec(
            "eod2_ohlcv_import_report.json", "json",
            required_fields=("enabled", "source", "price_policy", "volume_policy", "delivery_policy"),
        ),
    ],
    "fetch_indices_ohlcv.py": [
        ArtifactSpec("indices_ohlcv_data", "dir", min_count=1),
    ],
    "bulk_market_analyzer.py": [
        ArtifactSpec(
            "all_stocks_fundamental_analysis.json",
            "json",
            min_count=1,
            required_fields=("Symbol", "Name", "Basic Industry", "Sector", "Market Cap(Cr.)"),
        ),
    ],
    "advanced_metrics_processor.py": [
        ArtifactSpec("all_stocks_fundamental_analysis.json", "json", min_count=1),
    ],
    "process_earnings_performance.py": [
        ArtifactSpec("all_stocks_fundamental_analysis.json", "json", min_count=1),
    ],
    "enrich_fno_data.py": [
        ArtifactSpec("all_stocks_fundamental_analysis.json", "json", min_count=1),
    ],
    "enrich_delivery_data.py": [
        ArtifactSpec("all_stocks_fundamental_analysis.json", "json", min_count=1),
    ],
    "enrich_surveillance_status.py": [
        ArtifactSpec("all_stocks_fundamental_analysis.json", "json", min_count=1),
    ],
    "process_market_breadth.py": [
        ArtifactSpec("all_stocks_fundamental_analysis.json", "json", min_count=1),
        ArtifactSpec("sector_analytics.json", "json", min_count=1, required_fields=("sectors", "industries")),
    ],
    "process_historical_market_breadth.py": [
        ArtifactSpec("market_breadth.csv", "csv", min_count=2),
    ],
    "add_corporate_events.py": [
        ArtifactSpec(
            "all_stocks_fundamental_analysis.json",
            "json",
            min_count=1,
            required_fields=("Event Markers", "Recent Announcements", "News Feed"),
        ),
    ],
    "build_corporate_action_ledger.py": [
        ArtifactSpec("corporate_action_ledger.json", "json", required_fields=("source", "price_adjusted", "records")),
    ],
    "build_shareholding_history.py": [
        ArtifactSpec("shareholding_history.json", "json", min_count=1, required_fields=("source", "as_of_date", "records")),
    ],
    "enrich_published_fields.py": [
        ArtifactSpec("all_stocks_fundamental_analysis.json", "json", min_count=1,
                     required_fields=("Symbol", "vwap", "dividend_per_share_latest", "history_metadata", "all_time_high", "all_time_low", "return_5y")),
    ],
    "standardize_stock_artifact.py": [
        ArtifactSpec(
            "all_stocks_fundamental_analysis.json",
            "json",
            min_count=1,
            required_fields=REQUIRED_FINAL_FIELDS,
        ),
    ],
    "fetch_ipo_provider_data.py": [
        ArtifactSpec("ipo_provider_listed_archive.json.gz", "gzip_json", required_fields=("ipos",), nested_min_counts=(("ipos", 1),)),
        ArtifactSpec("ipo_provider_details_archive.json.gz", "gzip_json", required_fields=("details",)),
    ],
    "fetch_scanx_ipo_data.py": [
        ArtifactSpec("scanx_ipo_listed_archive.json.gz", "gzip_json", required_fields=("ipos",), nested_min_counts=(("ipos", 1),)),
        ArtifactSpec("scanx_ipo_details_archive.json.gz", "gzip_json", required_fields=("details",)),
    ],
    "build_ipo_screener_artifact.py": [
        ArtifactSpec("ipo_screener.json", "json", required_fields=("schema_version", "source", "as_of_date", "records", "provider_data", "pending_canonical_enrichment", "capabilities")),
    ],
    "fetch_etf_data.py": [
        ArtifactSpec("etf_data_response.json", "json", min_count=0),
    ],
}

FINAL_ARTIFACT_SPECS = [
    ArtifactSpec(
        "all_stocks_fundamental_analysis.json.gz",
        "gzip_json",
        min_count=1,
        required_fields=REQUIRED_FINAL_FIELDS,
    ),
    ArtifactSpec("sector_analytics.json.gz", "gzip_json", min_count=1, required_fields=("sectors", "industries")),
    ArtifactSpec("market_breadth.json.gz", "gzip_csv", min_count=2),
    ArtifactSpec("all_indices_list.json", "json", min_count=1),
    ArtifactSpec("market_breadth_v2.json.gz", "gzip_json", required_fields=("generated_at", "quality", "records"), nested_min_counts=(("records", 1),)),
    ArtifactSpec("breadth_universe_snapshot.json.gz", "gzip_json", required_fields=("generated_at", "eligible", "excluded")),
    ArtifactSpec("all_indices_history_v2.json.gz", "gzip_json", required_fields=("generated_at", "quality", "indices"), nested_min_counts=(("indices", 1),)),
    ArtifactSpec("sector_breadth_v2.json.gz", "gzip_json", required_fields=("generated_at", "sectors")),
    ArtifactSpec("market_breadth_contributions_v2.json.gz", "gzip_json", required_fields=("generated_at", "universes")),
    ArtifactSpec("corporate_action_ledger.json.gz", "gzip_json", required_fields=("source", "price_adjusted", "records")),
    ArtifactSpec("nse_corporate_actions.json.gz", "gzip_json", min_count=1, required_fields=("source", "range", "actions")),
    ArtifactSpec("nse_corporate_action_adjustments.json.gz", "gzip_json", min_count=1, required_fields=("source", "range", "revision", "actions")),
    ArtifactSpec("nse_fno_ban.json.gz", "gzip_json", required_fields=("source", "available", "trade_date", "symbols")),
    ArtifactSpec("earnings_calendar.json.gz", "gzip_json", required_fields=("source", "fetched_at", "events", "available")),
    ArtifactSpec("rs_rating_daily.json.gz", "gzip_json", required_fields=("source", "as_of_date", "ratings")),
    ArtifactSpec("ipo_screener.json.gz", "gzip_json", required_fields=("schema_version", "source", "as_of_date", "records", "provider_data", "pending_canonical_enrichment", "capabilities")),
    ArtifactSpec("ipo_provider_listed_archive.json.gz", "gzip_json", required_fields=("ipos",), nested_min_counts=(("ipos", 1),)),
    ArtifactSpec("ipo_provider_details_archive.json.gz", "gzip_json", required_fields=("details",)),
    ArtifactSpec("scanx_ipo_listed_archive.json.gz", "gzip_json", required_fields=("ipos",), nested_min_counts=(("ipos", 1),)),
    ArtifactSpec("scanx_ipo_details_archive.json.gz", "gzip_json", required_fields=("details",)),
    ArtifactSpec("shareholding_history.json.gz", "gzip_json", min_count=1, required_fields=("source", "as_of_date", "records")),
    ArtifactSpec("filing_history.json.gz", "gzip_json", min_count=1, required_fields=("source", "coverage", "records")),
    ArtifactSpec("quarterly_financial_history.json.gz", "gzip_json", min_count=0, required_fields=("source", "coverage", "records")),
    ArtifactSpec(
        "nse_universe_reconciliation.json", "json",
        required_fields=("available", "source", "as_of_date", "pending_scanx_enrichment", "alert_count"),
    ),
    ArtifactSpec(
        "mainboard_universe_report.json", "json",
        required_fields=("raw_scanx_count", "excluded_sme_count", "mainboard_count", "mainboard_scanx_count"),
    ),
    ArtifactSpec("sme_market_data.json.gz", "gzip_json", min_count=1, required_fields=("Symbol", "Series")),
]

SCRIPT_OUTPUT_SPECS[OHLCV_DERIVED_SCRIPT] = [
    ArtifactSpec(path, "json", required_fields=("generated_at",))
    for path in sorted(OHLCV_DERIVED_FILES)
]
INTERMEDIATE_FILES.extend(sorted(OHLCV_DERIVED_FILES))
