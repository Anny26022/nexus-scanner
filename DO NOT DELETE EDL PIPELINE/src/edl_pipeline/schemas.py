"""Stable scanner-native output schema for the generated stock artifact."""

REQUIRED_FINAL_FIELDS = [
    "schema_version",
    "symbol",
    "isin",
    "security_id",
    "name",
    "sector",
    "industry",
    "market_cap_crore",
    "close",
    "listing_board",
    "is_sme",
    "listing_series",
    "default_screener_eligible",
    "event_markers",
    "recent_announcements",
    "news_feed",
]


# ScanX statement amounts are INR crore. Convert explicitly lakh-labelled
# fields by ×100; ratios, per-share values and percentages retain their units.
# Screen API tag -> (canonical field, public row field). Amounts name their unit.
SCREEN_METRICS = {
    "Pb": ("pb_ratio", "pbRatio"),
    "Debt2Eq": ("debt_to_equity", "debtToEquity"),
    "EVEBITDA": ("ev_ebitda", "evEbitda"),
    "CurrentRto": ("current_ratio", "currentRatio"),
    "ReturnOnAssets": ("roa_percent", "roaPct"),
    "CWIP": ("cwip_crore", "cwipCrore"),
    "FixedAssets": ("fixed_assets_crore", "fixedAssetsCrore"),
    "Borrowings": ("borrowings_crore", "borrowingsCrore"),
    "FreeCashFlow": ("free_cash_flow_crore", "freeCashFlowCrore"),
    # Provider spelling verified against the ScanX screen API response.
    "FinanacingCashFlow": ("financing_cash_flow_crore", "financingCashFlowCrore"),
    "Year3ROE": ("average_roe_3y_percent", "averageRoe3yPct"),
    "Year3ROA": ("average_roa_3y_percent", "averageRoa3yPct"),
    "Year5AvgOperatingProfit": ("average_opm_5y_percent", "averageOpm5yPct"),
    "Year5MedianSalesGrowth": ("median_sales_growth_5y_percent", "medianSalesGrowth5yPct"),
    "Year1CAGREPSGrowth": ("eps_growth_1y_percent", "epsGrowth1yPct"),
    "Year3CAGREPSGrowth": ("eps_cagr_3y_percent", "epsCagr3yPct"),
    "Year3CAGRRevenueGrowth": ("revenue_cagr_3y_percent", "revenueCagr3yPct"),
    "FIIHolding": ("fii_holding_percent", "fiiHoldingPct"),
    "DIIHolding": ("dii_holding_percent", "diiHoldingPct"),
    "Ind_Pe": ("industry_pe_ratio", "industryPeRatio"),
}

PUBLIC_FINANCIAL_FIELDS = {
    canonical: public for canonical, public in SCREEN_METRICS.values()
}
PUBLIC_FINANCIAL_FIELDS.update({
    "promoter_holding_percent": "promoterHoldingPct",
    "public_holding_percent": "publicHoldingPct",
    "number_of_shareholders": "numberOfShareholders",
    "fii_percent_change_qoq": "fiiChangePctQoq",
    "dii_percent_change_qoq": "diiChangePctQoq",
    "eps_ttm": "epsTtm",
    "dividend_yield_percent": "dividendYieldPct",
    "face_value": "faceValue",
    "total_income_in_lakhs": "totalIncomeLakh",
    "total_expense_in_lakhs": "totalExpenseLakh",
    "profit_before_tax_in_lakhs": "profitBeforeTaxLakh",
    "total_tax_expenses_in_lakhs": "totalTaxExpensesLakh",
    "net_profit_in_lakhs": "netProfitLakh",
    "total_equity_in_lakhs": "totalEquityLakh",
    "total_assets_in_lakhs": "totalAssetsLakh",
    "current_assets_in_lakhs": "currentAssetsLakh",
    "current_liabilities_in_lakhs": "currentLiabilitiesLakh",
    "non_current_liabilities_in_lakhs": "nonCurrentLiabilitiesLakh",
    "operating_cash_flow_in_lakhs": "operatingCashFlowLakh",
    "investing_cash_flow_in_lakhs": "investingCashFlowLakh",
    "net_cash_flow_in_lakhs": "netCashFlowLakh",
})
