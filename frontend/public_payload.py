"""Published files describe the data, never where or how it was collected.

Every payload under public/data passes through `public` on its way out. Provenance stays in the
pipeline's private intermediates and reports.
"""

# Collection provenance and provider-hosted assets the app never reads.
PRIVATE_KEYS = frozenset({
    'source', 'source_url', 'sourceUrl', 'sourceUrls', 'source_dates', 'fetched_from', 'last_fetch_error',
    'mappingEvidenceUrl', 'cmpny_logo', 'logo_url',
    # Methodology notes that name the upstream feed.
    'debtToEquitySource', 'debt_to_equity_formula', 'completeness_basis',
})
# Provider-named containers keep their content under a neutral name.
RENAMED_KEYS = {'scanx': 'profile'}
# Provider-named labels, such as how a theme membership was mapped.
RENAMED_VALUES = {'stockscans_manual': 'manual', 'stockscans_inferred': 'inferred'}


def public(value):
    if isinstance(value, dict):
        return {RENAMED_KEYS.get(key, key): public(item) for key, item in value.items() if key not in PRIVATE_KEYS}
    if isinstance(value, list):
        return [public(item) for item in value]
    return RENAMED_VALUES.get(value, value) if isinstance(value, str) else value


def public_ipos(payload):
    """The IPO catalogue without the raw provider dump the app never reads."""
    payload = public(payload)
    if isinstance(payload, dict) and isinstance(payload.get('provider_data'), dict):
        payload['provider_data'].pop('profile', None)
    return payload
