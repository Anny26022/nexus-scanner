import tempfile
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import scanner_bridge as bridge
import pandas as pd
from scanner_cache import ScannerCache
from edl_pipeline.scanner.presets import list_presets


class BridgeTests(unittest.TestCase):
    def test_cache_reuses_scan_for_pagination_and_invalidates_changed_history(self):
        context={"stocks":{"TEST":self.stock()},"financial_history_as_of":"2026-09-30","rs_ratings":{},"fno_ban_symbols":{}}
        request={"asOfDate":"2026-09-30","universe":"mainboard","expressionTree":{"type":"group","operator":"all","children":[]}}
        with tempfile.TemporaryDirectory() as folder, patch.object(bridge,"_load_context",return_value=context) as load:
            root=Path(folder); (root/'ohlcv_data').mkdir(); path=root/'ohlcv_data/TEST.csv'
            self.history().to_csv(path,index=False)
            cache=ScannerCache()
            first=bridge.run(request,root,cache)
            self.assertEqual(first,bridge.run(request,root))
            calls=load.call_count
            second=bridge.run({**request,"page":2,"pageSize":1},root,cache)
            self.assertEqual(second['matchCount'],1); self.assertEqual(second['rows'],[])
            self.assertEqual(load.call_count,calls)
            # The compact cache reloads without parsing CSVs again.
            restored=ScannerCache(); restored.refresh(root)
            with patch('scanner_cache.pd.read_csv',side_effect=AssertionError('CSV should be cached')):
                self.assertEqual(restored.frame(root,'TEST','2026-09-30')['Close'].iloc[-1],100)
            modified=self.history(); modified.loc[modified.index[-1],'Close']=101
            modified.to_csv(path,index=False)
            changed=bridge.run(request,root,cache)
            self.assertEqual(changed['rows'][0]['close'],101)
            self.assertGreater(load.call_count,calls)

    def history(self, count=60, latest="2026-09-30"):
        return pd.DataFrame({"Date":pd.bdate_range(end=latest,periods=count),"Open":100.,"High":101.,"Low":99.,"Close":100.,"Volume":[100.]*(count-1)+[200.]})

    def test_rvol_upper_bound_uses_history_when_snapshot_is_missing_or_wrong(self):
        node=bridge.translate("mom_rvol",{"minRvol":1.5,"maxRvol":3})
        stock={**self.stock(),"relative_volume_20":None}
        self.assertTrue(bridge.evaluate(node,stock,self.history(),{},"2026-09-30",set(),[]))
        self.assertTrue(bridge.evaluate(node,{**stock,"relative_volume_20":99},self.history(),{},"2026-09-30",set(),[]))
        node=bridge.translate("mom_rvol",{"minRvol":1.5,"maxRvol":1.8})
        self.assertFalse(bridge.evaluate(node,stock,self.history(),{},"2026-09-30",set(),[]))

    def test_short_and_stale_history_have_specific_diagnostics(self):
        node=bridge.translate("PRICE_VS_SMA",{"period":50,"persistDays":1,"comparison":"ABOVE"})
        diagnostics=set()
        self.assertIsNone(bridge.evaluate(node,self.stock(),self.history(10),{},"2026-09-30",diagnostics,[]))
        self.assertIn(("PRICE_VS_SMA","insufficient_history"),diagnostics)
        diagnostics=set()
        self.assertIsNone(bridge.evaluate(node,self.stock(),self.history(latest="2026-09-29"),{},"2026-09-30",diagnostics,[]))
        self.assertIn(("PRICE_VS_SMA","stock_history_not_aligned_to_screen_date"),diagnostics)

    def stock(self):
        return {"symbol":"TEST","as_of_date":"2026-09-30","market_cap_crore":5000,"close":100,
                "open":98,"high":101,"low":97,"volume":1000000,"daily_rupee_turnover_50_cr":10,
                "circuit_limit":"20","relative_volume_20":2,"sma50":90,"change_percent":3}

    def test_all_45_presets_translate_and_never_silently_pass_missing_history(self):
        context={"stock":self.stock(),"financial_history":{},"financial_history_as_of":"2026-09-30"}
        for preset in list_presets():
            with self.subTest(preset=preset["id"]):
                node=bridge.translate(preset["id"],{})
                diagnostics=set()
                value=bridge.evaluate(node,self.stock(),None,context,"2026-09-30",diagnostics,[])
                self.assertIn(value,(True,False,None))
                if value is None:
                    self.assertTrue(diagnostics)

    def test_baseline_restrictions_are_preserved_and_missing_is_unknown(self):
        self.assertTrue(bridge.preset_baseline(self.stock()))
        for field,value in [("market_cap_crore",500),("close",5),("daily_rupee_turnover_50_cr",1)]:
            self.assertFalse(bridge.preset_baseline({**self.stock(),field:value}))
        self.assertTrue(bridge.preset_baseline({**self.stock(),"market_cap_crore":2_000_000,"close":100_000}))
        self.assertTrue(bridge.preset_baseline({**self.stock(),"circuit_limit":"5%"}))
        self.assertIsNone(bridge.preset_baseline({**self.stock(),"daily_rupee_turnover_50_cr":None}))

    def test_financial_leaf_uses_ledger_instead_of_snapshot(self):
        rows=[{"quarter_end":q,"filing_date":"2026-08-01","report_type":"CONSOLIDATED","net_profit":100}
              for q in ["2025-09-30","2025-12-31","2026-03-31","2026-06-30"]]
        context={"financial_history":{"TEST":rows},"financial_history_as_of":"2026-09-30"}
        stock={**self.stock(),"pe_ratio":999}
        node=bridge.translate("PE_RATIO",{"comparison":"BELOW","value":20,"reportType":"CONSOLIDATED"})
        self.assertTrue(bridge.evaluate(node,stock,None,context,"2026-09-30",set(),[]))

    def test_all_time_high_distance_uses_published_adjusted_history_metric(self):
        node=bridge.translate("PCT_FROM_ATH",{"comparison":"BELOW","pct":10})
        self.assertTrue(bridge.evaluate(node,{**self.stock(),"percent_from_ath":8.5},None,{},"2026-09-30",set(),[]))
        self.assertFalse(bridge.evaluate(node,{**self.stock(),"percent_from_ath":12},None,{},"2026-09-30",set(),[]))

    def test_surveillance_filter_excludes_asm_or_gsm_and_never_guesses(self):
        node=bridge.translate("EXCLUDE_SURVEILLANCE",{})
        available={**self.stock(),"surveillance_available":True,"surveillance_as_of_date":"2026-09-30","is_asm":False,"is_gsm":False}
        self.assertTrue(bridge.evaluate(node,available,None,{},"2026-09-30",set(),[]))
        self.assertFalse(bridge.evaluate(node,{**available,"is_asm":True,"asm_stage":"LTASM - I"},None,{},"2026-09-30",set(),[]))
        self.assertFalse(bridge.evaluate(node,{**available,"is_gsm":True,"gsm_stage":"GSM Stage 2"},None,{},"2026-09-30",set(),[]))
        self.assertIsNone(bridge.evaluate(node,{**available,"surveillance_available":False},None,{},"2026-09-30",set(),[]))

    def test_current_fundamental_metrics_and_annual_eps_are_evaluable(self):
        stock={**self.stock(),"roe_percent":18,"roce_percent":20,"operating_margin_ttm_percent":14,
               "debt_to_equity":0.4,"peg_ratio":1.2,"sales_growth_5_years_percent":16,
               "eps_last_year":12,"eps_2_years_back":10}
        self.assertTrue(bridge.evaluate(bridge.translate("FUNDAMENTAL_METRIC",{"metric":"ROE","comparison":"ABOVE","value":15}),stock,None,{},"2026-09-30",set(),[]))
        self.assertTrue(bridge.evaluate(bridge.translate("EPS_LAST_YEAR_HIGHER",{}),stock,None,{},"2026-09-30",set(),[]))
        self.assertFalse(bridge.evaluate(bridge.translate("EPS_LAST_YEAR_HIGHER",{}),{**stock,"eps_last_year":8},None,{},"2026-09-30",set(),[]))

    def test_absolute_volume_eps_and_dividend_yield_use_their_native_units(self):
        stock={**self.stock(),"eps_ttm":25,"dividend_yield_percent":2.5}
        frame=self.history(); frame.loc[frame.index[-1],"Volume"]=1_000_000
        self.assertTrue(bridge.evaluate(bridge.translate("ABSOLUTE_VOLUME",{"comparison":"ABOVE","value":1_000_000}),stock,frame,{},"2026-09-30",set(),[]))
        self.assertTrue(bridge.evaluate(bridge.translate("ABSOLUTE_EPS",{"comparison":"GREATER","value":20}),stock,frame,{},"2026-09-30",set(),[]))
        self.assertTrue(bridge.evaluate(bridge.translate("DIVIDEND_YIELD",{"comparison":"GREATER","value":2}),stock,frame,{},"2026-09-30",set(),[]))

    def test_delivery_spike_loads_history_for_the_contract_kind(self):
        expression = {"type":"condition","kind":"DELIVERY_PCT_SPIKE","params":{"minDeliverablePct":60,"withinDays":1}}
        self.assertTrue(bridge._needs_delivery(expression))
        self.assertTrue(bridge._needs_delivery({"type":"condition","kind":"DELIVERY_PERCENT","params":{}}))
        self.assertFalse(bridge._needs_delivery({"type":"condition","kind":"PE_RATIO","params":{}}))

    def test_snapshot_field_query_without_history_has_stable_diagnostics(self):
        node=bridge.compile_query("Earning Per Share (EPS) > 20")
        stock={**self.stock(),"eps_ttm":25}
        self.assertTrue(bridge.evaluate(node,stock,None,{},"2026-09-30",set(),[]))

        diagnostics=set()
        self.assertIsNone(bridge.evaluate(node,{**stock,"eps_ttm":None},None,{},"2026-09-30",diagnostics,[]))
        self.assertIn(("field_comparison","snapshot_value_unavailable"),diagnostics)

    def test_current_valuation_conditions_reject_stale_history_frames(self):
        stale=self.history(latest="2026-09-29")
        for kind,params in [
            ("MARKETCAP",{"comparison":"ABOVE","valueCr":1_000}),
            ("FF_MARKETCAP",{"comparison":"ABOVE","valueCr":1_000}),
            ("PE_RATIO",{"comparison":"BELOW","value":25}),
        ]:
            with self.subTest(kind=kind):
                diagnostics=set()
                value=bridge.evaluate(bridge.translate(kind,params),self.stock(),stale,{},"2026-09-30",diagnostics,[])
                self.assertIsNone(value)
                self.assertIn((kind,"stock_history_not_aligned_to_screen_date"),diagnostics)

    def test_all_native_condition_defaults_execute(self):
        catalog=json.loads((Path(__file__).parent/"src/data/nativeConditions.json").read_text())
        self.assertEqual(len(catalog),54)
        for item in catalog:
            with self.subTest(condition=item["id"]):
                params={p["id"]:p["defaultValue"] for p in item["parameters"]}
                expression=bridge.translate(item["id"],params)
                value=bridge.evaluate(expression,self.stock(),None,{},"2026-09-30",set(),[])
                self.assertIn(value,(True,False,None))

    def test_unknown_filters_raise_and_and_or_preserve_unknown(self):
        with self.assertRaises(ValueError): bridge.translate("invented",{})
        self.assertIsNone(bridge.combine([True,None],"AND"))
        self.assertTrue(bridge.combine([True,None],"OR"))
        self.assertFalse(bridge.combine([False,None],"AND"))

    def test_custom_return_upper_bound_is_not_translated_to_negative_return(self):
        node=bridge.translate("mom_return",{"period":"1D","minReturn":2,"maxReturn":10})
        self.assertTrue(bridge.evaluate(node,self.stock(),None,{},"2026-09-30",set(),[]))

    def test_single_snapshot_cannot_fake_multi_day_inside_bar(self):
        s={**self.stock(),"is_inside_day":True}
        node=bridge.translate("range_inside_bar",{"timeframe":"Daily","consecutive":2})
        self.assertIsNone(bridge.evaluate(node,s,None,{},"2026-09-30",set(),[]))

    def test_snapshot_screen_returns_current_matches_and_rejects_missing_historical_cache(self):
        context={"stocks":{"TEST":self.stock()},"financial_history_as_of":"2026-09-30","rs_ratings":{},"fno_ban_symbols":{}}
        request={"asOfDate":"2026-09-30","universe":"mainboard","expressionTree":{"type":"group","operator":"all","children":[]}}
        with tempfile.TemporaryDirectory() as folder,patch.object(bridge,"_load_context",return_value=context):
            response=bridge.run(request,Path(folder))
            self.assertEqual(response["matchCount"],1)
            with self.assertRaises(ValueError): bridge.run({**request,"asOfDate":"2026-09-29"},Path(folder))

    def test_text_query_is_compiled_by_python_and_rejects_unsupported_clauses(self):
        context={"stocks":{"TEST":self.stock()},"financial_history_as_of":"2026-09-30","rs_ratings":{},"fno_ban_symbols":{}}
        request={"asOfDate":"2026-09-30","universe":"mainboard",
                 "expressionTree":{"type":"group","operator":"all","children":[]},
                 "textQuery":"(Close Price > 50 AND Close Price < 150) AND Volume (in Lakhs) >= 0.001"}
        with tempfile.TemporaryDirectory() as folder, patch.object(bridge,"_load_context",return_value=context):
            root=Path(folder); (root/'ohlcv_data').mkdir(); self.history().to_csv(root/'ohlcv_data/TEST.csv',index=False)
            response=bridge.run(request,root)
            self.assertEqual(response["matchCount"],1)
            with self.assertRaisesRegex(ValueError,"Unsupported query field"):
                bridge.run({**request,"textQuery":"Unknown Metric > 5"},root)

    def test_historical_rows_do_not_reuse_current_snapshot_enrichments(self):
        stock={**self.stock(),"as_of_date":"2026-09-30","total_revenue_in_lakhs":1000,
               "non_current_assets_in_lakhs":2000,"total_liabilities_in_lakhs":800,
               "interest_coverage":5,"dividend_per_share_latest":2,"vwap":100,
               "vwap_as_of_date":"2026-09-30","all_time_high":150,"all_time_low":20,
               "return_5y":80,"roe_percent":18,"eps_last_year":12}
        context={"stocks":{"TEST":stock},"financial_history_as_of":"2026-09-30",
                 "rs_ratings":{},"fno_ban_symbols":{}}
        request={"asOfDate":"2026-09-29","universe":"mainboard",
                 "expressionTree":{"type":"group","operator":"all","children":[]}}
        with tempfile.TemporaryDirectory() as folder, patch.object(bridge,"_load_context",return_value=context):
            root=Path(folder); (root/'ohlcv_data').mkdir()
            self.history(latest="2026-09-29").to_csv(root/'ohlcv_data/TEST.csv',index=False)
            row=bridge.run(request,root)["rows"][0]
            for field in ("totalRevenueLakh","nonCurrentAssetsLakh","totalLiabilitiesLakh",
                          "interestCoverage","dividendPerShare","vwap","vwapAsOfDate",
                          "allTimeHigh","allTimeLow","return5yPct","roePct","epsLastYear"):
                self.assertIsNone(row[field], field)
            values = [value for field, value in row.items() if field != "dataCompleteness"]
            self.assertEqual(row["dataCompleteness"], round(100 * sum(value is not None for value in values) / len(values)))
