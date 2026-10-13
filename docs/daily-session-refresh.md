# Daily session and official price safeguards

Index history targets the latest stock session only when at least 90% of the
current equity master covers it. The fetch range ends at that session rather
than advancing with the runner's calendar date. Dated provider candles take
priority; an undated snapshot can fill a missing candle only when its capture
timestamp falls between that session's opening and the next weekday opening.
Unconfirmed stock coverage stops the index refresh, and publication validation
still checks alignment. This retains the current main-branch session safeguards.

Official stock OHLCV replaces a vendor snapshot only for the same session
(or when the snapshot has no date). Missing symbols, mismatched row dates and
stale staged sessions leave the snapshot prices, daily return and date intact.
After an accepted replacement, daily return uses NSE `PREV_CLOSE`, falling back
to the latest earlier cached close. A missing valid reference produces an
unavailable return rather than retaining a vendor return for a different close.

Opening-auction prices outside the regular-session range may expand the daily
candle envelope only within 5% of the relevant reported high or low. Larger
deviations are rejected. This conservative ingestion guard is not evidence
that every smaller deviation is genuine, and it may reject a legitimate larger
auction deviation. The official open, reported range and adjustment flag remain
available in normalized source records; reported range and provenance also
survive stock canonicalization. Existing historical CSVs are not repaired by
this change; the next official refresh applies the new normalization policy.
