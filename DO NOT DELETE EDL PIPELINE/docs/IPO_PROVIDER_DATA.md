# IPO provider enrichment

`ipo_provider_listed_archive.json.gz` begins with a user-supplied listing archive captured on 4 October 2026. It contains 2,652 provider issue records from 2003 through 1 October 2026. It is not a live feed. Its compressed size is about 280 KB.

`fetch_ipo_provider_data.py` fetches the permitted `listed?days=60` window on each pipeline run. It replaces matching archive records by provider issue ID and publishes the compact, growing `ipo_provider_listed_archive.json.gz` and `ipo_provider_details_archive.json.gz` with the other validated pipeline artifacts. Working copies also live in the Actions cache. If that cache is lost, the published archives are restored before recent records are merged. The live open, upcoming, closed, analytics and issue detail feeds are fetched separately. The full `days=all` API responds with HTTP 403 and is not called by the pipeline.

The NSE EQ listing file and canonical stock universe determine which rows enter the mainboard IPO catalogue. Provider issue terms are joined only for NSE mainboard records with the same symbol **and exact listing date**. This matters because a symbol may have a later offering or a provider date that differs from the NSE listing date. An unmatched issue price remains null.

The provider's 2026 yearly summary currently reports 105 mainboard and 156 SME listings with gains. The supplied listed archive contains 94 mainboard and 156 SME listings with gains for 2026. The 11 mainboard records behind that difference are not identified by the yearly aggregate, so the aggregate must not be used to fill individual catalogue rows. Provider coverage and source accuracy still need independent validation.
