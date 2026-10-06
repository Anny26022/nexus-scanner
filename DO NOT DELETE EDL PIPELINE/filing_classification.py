"""Deterministic disclosure topics; labels describe filings, not investment impact."""
from __future__ import annotations

import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

VERSION = 3

# Stable IDs, group, display name, and deliberately specific text rules.
_GROUPS = {
    "results": [("financial_results", "Financial results", r"financial results|integrated filing financial"),
                ("annual_report", "Annual report", r"annual report"),
                ("financial_revision", "Results delay / correction", r"delay(?:ed)? .*financial results|non submission of financial results|restatement|voluntary revision of financial")],
    "board_meetings": [("board_intimation", "Board meeting intimation", r"board meeting intimation|board meeting$"),
                       ("board_outcome", "Board meeting outcome", r"outcome of board meeting|board meeting outcome|outcome without intimation"),
                       ("board_change", "Board meeting change", r"board meeting (?:rescheduled|cancelled)|reschedul.*board meeting")],
    "business": [("general_announcement", "General announcement", r"^general(?: announcements?)?$"),
                 ("order_win", "Order win", r"award of order|receipt of order|bagging.{0,60}(?:order|contract)|awarding of orders?|(?:received|secured|awarded).{0,60}(?:contract|commercial order|purchase order)"),
                 ("press_release", "Press release", r"press release|media release"),
                 ("business_update", "Business update / Monthly update", r"(?:monthly|quarterly|business|operational|operation) (?:business )?updates?|production figures|sales (?:performance|figures|volume)|quarterly newsletter"),
                 ("investor_presentation", "Investor presentation", r"(?:investor|corporate|earnings) (?:presentation|deck)"),
                 ("capex", "Capex / expansion", r"capacity (?:addition|expansion|enhancement)|capital expenditure|\bcapex\b|plant expansion|brownfield|greenfield|doubl\w* .{0,60}capacity"),
                 ("commissioning", "Commercial production / commissioning", r"commercial production|commencement of .{0,60}operations|commission(?:ing|ed)"),
                 ("regulatory_approval", "Regulatory approval", r"regulatory approval|(?:usfda|us fda|fda).{0,60}approv|approv.{0,60}(?:usfda|us fda|fda)|(?:grant|approval).{0,40}licen[cs]e"),
                 ("regulatory_update", "Regulatory update / restriction", r"import alert|warning letter|form 483|(?:usfda|us fda|fda).{0,60}(?:inspection|observation)|key licen[cs]es"),
                 ("product_launch", "Product launch / opening", r"product launch|opening of .{0,60}(?:store|branch|hospital|hotel|facility)|launch of .{0,60}product|inaugurat"),
                 ("recognition", "Award / recognition", r"award.*recognition|received .*award|won .*award")],
    "strategic": [("acquisition", "Acquisition", r"\bacquisition\b"),
                  ("merger", "Merger / demerger", r"\bmerger\b|\bdemerger\b|amalgamation|scheme of arrangement"),
                  ("joint_venture", "Joint venture / MoU", r"joint venture|memorandum of understanding|strategic .*tie up"),
                  ("divestment", "Divestment", r"disinvestment|divestment|sale or disposal"),
                  ("subsidiary", "New venture / subsidiary", r"incorporation|new subsidiary|new venture")],
    "capital": [("bonus_split", "Bonus / split", r"\bbonus\b|stock split|sub division"),
                ("buyback", "Buyback", r"buy back|buyback"),
                ("listing", "Listing / delisting", r"new listing|\bdelisting\b"),
                ("dividend", "Dividend", r"\bdividend\b"),
                ("open_offer", "Open offer / takeover", r"open offer|takeover"),
                ("fundraise", "Fundraise", r"raising of funds|funds raising|qualified institutional placement|\bqip\b|preferential issue|rights? issue|issue of securities"),
                ("allotment", "Allotment", r"allotment of (?:equity shares|securities|warrants)|\ballotment\b"),
                ("record_date", "Record date", r"record date"),
                ("borrowing", "Borrowing / guarantee", r"\bborrowing\b|giving guarantees|giving .*indemnity"),
                ("esop", "ESOP allotment", r"\besop\b|\besps\b|\besos\b"),
                ("ofs", "Offer for sale", r"offer for sale"),
                ("debt_repayment", "Debt repayment / redemption", r"repayment of commercial paper|certificate of interest payment|\bredemption\b"),
                ("fund_utilisation", "Fund utilisation / deviation", r"monitoring agency report|statement of deviation|utilisation of funds")],
    "ownership": [("stake_change", "Stake change (SAST)", r"sast|shareholding.*change"),
                  ("pledge", "Pledge (SAST)", r"\bpledge\b|encumbrance|reg 31 1|reg 31 2"),
                  ("credit_rating", "Credit rating", r"credit rating"),
                  ("esg_rating", "ESG rating", r"esg rating"),
                  ("shareholding_pattern", "Shareholding pattern", r"^shareholding$|shareholding pattern"),
                  ("insider_transaction", "Insider transaction", r"regulation 7 2|reg 7 2|form c|continual disclosure|insider trading"),
                  ("trading_plan", "Insider trading plan", r"trading plan")],
    "legal": [("clarification", "Clarification / rumour", r"clarification|rumou?r|news verification|price movement|spurt in volume"),
              ("disruption", "Strike / lockout / winding-up", r"\bstrike|lockout|winding up|disruption of operations"),
              ("debt_default", "Debt default", r"defaults? on payment|defaults? on .*interest|defaults? on .*principal|defaults on payment"),
              ("insolvency", "Insolvency (CIRP)", r"insolvency|\bcirp\b|resolution plan|resolution professional|committee of creditors|list of creditors"),
              ("litigation", "Litigation / notice / penalty", r"litigation|\bpenalt|legal notice|tax .*order|order .*tax|action s .*orders passed"),
              ("workforce", "Workforce / restructuring", r"workforce|layoff|retrenchment|^restructuring$"),
              ("fraud", "Fraud / arrest", r"\bfraud|\barrest")],
    "governance": [("kmp_change", "KMP change", r"change in management|chief executive|chief financial|managing director|chairman|\bkmp\b"),
                   ("auditor_change", "Auditor change", r"change in auditors|appointment of .*auditor|resignation of .*auditor"),
                   ("director_change", "Director change", r"change in director|resignation of director|independent director"),
                   ("secretary_change", "Company secretary change", r"company secretary|compliance officer"),
                   ("related_party", "Related-party transactions", r"related party transactions")],
    "meetings": [("shareholder_meeting", "Shareholder meeting", r"\bagm\b|\begm\b|postal ballot|shareholders? meeting|court convened meeting"),
                 ("call_transcript", "Earnings call transcript", r"earnings call transcript|call transcript|^transcript$"),
                 ("investor_meet", "Analyst / investor meet", r"analyst.*meet|investor meet|institutional investor")],
    "other": [("administration", "Company administration", r"address change|office address|change of name|name change|symbol change|amendment.*(?:aoa|moa|memorandum|articles)"),
              ("compliance", "Compliance filing", r"compliance|certificate under|investor complaints|trading window|asset cover|structural digital database"),
              ("post_action", "Post-action paperwork", r"daily buy back|post buyback|post offer|closure of buy back"),
              ("newspaper", "Newspaper publication", r"newspaper publication|copy of newspaper")],
}

def _text(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()

RULES = tuple((key, group, name, re.compile(pattern))
              for group, rows in _GROUPS.items() for key, name, pattern in rows)
TAXONOMY = [{"id": key, "group": group, "label": name} for key, group, name, _ in RULES]

@lru_cache(maxsize=1)
def source_label_mapping():
    return json.loads(Path(__file__).with_name("filing_source_labels.json").read_text())["fields"]


_WRAPPERS = {"board_intimation", "board_outcome", "board_change", "press_release", "general_announcement"}
_LEGAL_ORDER = re.compile(r"tax officer|tax assessment|tax demand|assessment order|court order|tribunal order|arbitral award|adjudication|penalty|litigation")
_COMMERCIAL_ORDER = re.compile(r"purchase order|commercial order|contract|letter of acceptance|letter of award")


def _status(text):
    for status, pattern in (
        ("withdrawn", r"withdrawal|withdrawn|withdrew"),
        ("cancelled", r"cancelled|cancellation"),
        ("not_completed", r"\bnot (?:yet )?(?:been )?(?:commenced|commissioned|completed)\b"),
        ("not_approved", r"\bnot (?:yet )?(?:been )?(?:approved|declared)\b"
                         r"|\bno approval(?: was| has been| is)? (?:granted|received|obtained)\b"
                         r"|\bapproval.{0,20}\bnot (?:yet )?(?:been )?(?:granted|received|obtained|secured)\b"
                         r"|\bnot (?:yet )?(?:been )?(?:granted|received|obtained|secured)(?: \w+){0,3} approval\b"),
        ("revised", r"revised|revision|corrigendum|restatement"),
        ("conditional", r"if any|subject to approval|subject to .*conditions"),
        ("proposed", r"to consider|scheduled|proposal|proposed|plans to|pending approval|awaiting approval|approval (?:pending|awaited)"),
        ("completed", r"completed|completion|commissioned|commenced|inaugurat"),
        ("approved", r"approved|declared|(?:granted|received|obtained|secured).{0,40}approval|approval.{0,40}(?:granted|received|obtained)"),
    ):
        if re.search(pattern, text):
            return status
    return "unspecified"


def _regulatory(text):
    if re.search(r"lifting of import alert|import alert.{0,30}(?:lifted|removed)", text):
        return "restriction_lifted"
    if re.search(r"no adverse observations|no observations|zero observations|no objection", text):
        return "no_adverse_observations"
    if re.search(r"warning letter|form 483|import alert|adverse observations", text):
        return "adverse_observations"
    if re.search(r"reject|suspend|revok|withdraw|cancel", text):
        return "restriction"
    if _status(text) == 'proposed':
        return 'pending'
    if _status(text) == 'approved':
        return "approval"
    return "unspecified"


def _clauses(filing):
    boundary = r"[;\n]|[.!?](?=\s+[A-Z]|\s*$)|\band\b(?=\s+(?:approved|withdrew|withdrawn|cancelled|proposed|declared|completed))"
    for field in ("caption", "news_body"):
        raw = str(filing.get(field) or "")
        start = 0
        for match in re.finditer(boundary, raw):
            clause = raw[start:match.start()].strip()
            # Keep a correction modifier attached to its action and preserve
            # the literal source excerpt, including the joining word.
            if match.group() == "and" and _text(clause) in {"revised", "revision", "corrigendum", "restatement"}:
                continue
            if clause:
                yield field, clause, _text(clause)
            start = match.end()
        clause = raw[start:].strip()
        if clause:
            yield field, clause, _text(clause)


def classify_filing(filing):
    """Classify topics and per-event status, retaining the evidence used."""
    mapping = source_label_mapping()
    evidence = {}
    labels = []
    label_fields = ('descriptor', 'ann_type', 'cat')
    label_sets = sorted({tuple(str(row.get(field) or '') for field in label_fields)
                         for row in [filing, *filing.get('sourceLabels', [])]})
    for label_set in label_sets:
        source_labels = dict(zip(label_fields, label_set))
        for field in ("descriptor", "ann_type", "cat"):
            value = _text(source_labels.get(field)); labels.append(value)
            mapped = mapping.get(field, {}).get(value)
            # Unseen labels can use specific rules; known ambiguous labels map to [].
            if mapped is None:
                mapped = [key for key, _, _, rx in RULES if rx.search(value)]
            for key in mapped:
                evidence.setdefault(key, []).append({"field": field, "excerpt": str(source_labels.get(field))[:180], "status": "unspecified", "reference": "unspecified", "match": "source_label"})
    clauses = list(_clauses(filing))
    label_topics = set(evidence)
    generic = not label_topics or label_topics <= _WRAPPERS
    # Presentations describe many historical achievements. Refine their explicit
    # topic evidence only; do not interpret every discussed achievement as news.
    for field, raw, text in clauses:
        candidates = [key for key, _, _, rx in RULES if rx.search(text)]
        if "fraud" in candidates:
            candidates = [key for key in candidates if key not in {"business_update", "order_win"}]
        if _LEGAL_ORDER.search(text):
            candidates = [key for key in candidates if key != "order_win"]
            candidates.append("litigation")
        for key in candidates:
            regulatory_refinement = key == 'regulatory_update' and 'regulatory_approval' in label_topics
            if key == "general_announcement" or (not generic and key not in label_topics and not regulatory_refinement):
                continue
            if key in {"kmp_change", "director_change", "secretary_change"} and not re.search(r"appoint|resign|retire|change|cessation|demise", text):
                continue
            item = {"field": field, "excerpt": raw[:180], "status": _status(text),
                    "reference": "historical" if re.search(r"previously announced|earlier announcement|last year", text) else "unspecified",
                    "match": "text_rule"}
            if key in {"regulatory_approval", "regulatory_update"}:
                item["outcome"] = _regulatory(text)
                if item["outcome"] in {"restriction", "adverse_observations"}:
                    item["status"] = "adverse"
                elif item["outcome"] == "restriction_lifted":
                    item["status"] = "restriction_lifted"
                if key == 'regulatory_approval' and item['outcome'] not in {'approval', 'unspecified'}:
                    key = 'regulatory_update'
            evidence.setdefault(key, []).append(item)
    combined = " ".join(labels + [text for _, _, text in clauses])
    if _LEGAL_ORDER.search(combined) and "order_win" in evidence and not any(_COMMERCIAL_ORDER.search(text) and not _LEGAL_ORDER.search(text) for _, _, text in clauses):
        evidence.pop("order_win", None)
        evidence.setdefault("litigation", [{"field": "caption", "excerpt": str(filing.get('caption') or '')[:180], "status": "unspecified", "reference": "unspecified", "match": "legal_order_exclusion"}])
    for specific, broad in (("esop", "allotment"), ("pledge", "stake_change"), ("post_action", "buyback")):
        if specific in evidence:
            evidence.pop(broad, None)
    if "trading_plan" in evidence or "trading window" in combined:
        evidence.pop("insider_transaction", None)
        evidence.pop("stake_change", None)
    if "board_intimation" in evidence:
        evidence.pop("financial_results", None)
    if "board_outcome" in evidence or "board_change" in evidence:
        evidence.pop("board_intimation", None)
    if len(evidence) > 1:
        evidence.pop("general_announcement", None)
    if 'regulatory_approval' in evidence and 'regulatory_update' in evidence:
        negative_clauses = {(m['field'], m['excerpt']) for m in evidence['regulatory_update']
                            if m.get('outcome') in {'restriction', 'adverse_observations',
                                                   'restriction_lifted', 'no_adverse_observations'}}
        if negative_clauses:
            # Discard the broad approval label, not an independent approval clause.
            approvals = [m for m in evidence['regulatory_approval']
                         if m['match'] == 'text_rule'
                         and (m['field'], m['excerpt']) not in negative_clauses]
            if approvals:
                evidence['regulatory_approval'] = approvals
            else:
                evidence.pop('regulatory_approval', None)
    events = []
    for topic, matches in sorted(evidence.items()):
        text_matches = [m for m in matches if m['match'] == 'text_rule']
        selected = text_matches or matches
        # Deduplicate caption/body repetition without letting a label erase status.
        variants = {}
        for match in selected:
            status = match['status']
            if 'board_intimation' in evidence and topic not in _WRAPPERS and status not in {'withdrawn', 'cancelled'}:
                status = 'conditional' if 'if any' in _text(match['excerpt']) else 'proposed'
            if topic == 'board_intimation':
                status = 'proposed'
            key = (status, match['reference'], match.get('outcome'))
            variants.setdefault(key, {"topic": topic, "status": status, "reference": match['reference'],
                                      "ruleId": f"v{VERSION}:{topic}", "evidence": match})
        events.extend(variants.values())
    statuses = {e['status'] for e in events if e['topic'] not in _WRAPPERS and e['status'] != 'unspecified'}
    if not statuses:
        statuses = {e['status'] for e in events if e['status'] != 'unspecified'}
    document_type = next((key for key in ("board_intimation", "board_outcome", "press_release", "call_transcript", "investor_presentation", "annual_report") if key in evidence), "filing")
    subtypes = [name for name, pattern in (
        ('sustainability_report', r'brsr|business responsibility'),
        ('securities_certificate', r'loss of certificate|duplicate certificate|transfer transmission'),
        ('book_closure', r'book closure'), ('auditor_report', r'auditors report|limited review report'),
        ('provisional_update', r'provisional .*updates?'),
    ) if re.search(pattern, combined)]
    return {"version": VERSION, "topics": sorted(evidence) or ["unclassified"], "events": events, "subtypes": subtypes,
            "documentType": document_type, "status": next(iter(statuses)) if len(statuses) == 1 else 'mixed' if statuses else 'unspecified',
            "matchedRuleIds": [f"v{VERSION}:{key}" for key in sorted(evidence)],
            "method": "predefined_rules", "basis": "source_labels_and_text" if label_topics else "filing_text"}


def classify_corporate_action(action):
    """Read official NSE terms without deriving dates or adjustment factors."""
    subject = str(action.get('source_details') or action.get('subject') or '')
    text = _text(subject)
    types = _text(action.get('action_type') or ','.join(action.get('categories') or []))
    topics = []
    for key, pattern in (('dividend', r'dividend'), ('bonus_split', r'bonus|split|consolidation'),
                         ('fundraise', r'rights'), ('buyback', r'buyback|buy back'),
                         ('merger', r'merger|demerger|scheme|amalgamation')):
        if re.search(pattern, types): topics.append(key)
    terms = {}
    for key, value in (('exDate', action.get('ex_date') or action.get('exDate')),
                       ('recordDate', action.get('record_date') or action.get('recordDate'))):
        if value:
            terms[key] = value
    if 'dividend' in topics:
        amounts = re.findall(r'\b(?:Rs\.?|Re\.?)\s*(\d+(?:\.\d+)?)\s*(?:/-)?\s*Per\s+Share', subject, re.I)
        if amounts: terms['dividendAmountsRupeesPerShare'] = [float(n) for n in amounts]
    if 'bonus' in types:
        ratio = re.search(r'bonus\s*[-:]?\s*(\d+)\s*:\s*(\d+)', subject, re.I)
        if ratio and int(ratio[2]) > 0: terms['bonusRatio'] = {'issued': int(ratio[1]), 'held': int(ratio[2])}
    if 'split' in types:
        face_values = re.search(r'from\s+(?:Rs\.?|Re\.?)\s*(\d+(?:\.\d+)?).*?to\s+(?:Rs\.?|Re\.?)\s*(\d+(?:\.\d+)?)', subject, re.I)
        if face_values: terms['splitFaceValuesRupees'] = {'old': float(face_values[1]), 'new': float(face_values[2])}
    if subject:
        terms['rawSubject'] = subject
    return {'version': VERSION, 'topics': sorted(topics) or ['unclassified'], 'terms': terms,
            'source': 'NSE corporate actions', 'method': 'official_subject_rules'}

def classify_filings(filings):
    """Merge identical same-time documents across feeds; preserve revisions."""
    result, seen = [], {}
    for raw in filings:
        row = dict(raw)
        url = str(row.get("file_url") or "").strip()
        parts = urlsplit(url)
        url_key = urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, parts.query, ""))
        # Timestamp and content protect revisions even if a provider reuses a URL.
        identity = (str(row.get("news_date") or ""), url_key, _text(row.get("caption")), _text(row.get("news_body")))
        source = row.get("source_endpoint")
        if url and identity in seen:
            existing = seen[identity]
            existing["sourceEndpoints"] = sorted(set(existing["sourceEndpoints"] + ([source] if source else [])))
            source_labels = {k: row.get(k) for k in ("source_endpoint", "descriptor", "ann_type", "cat")}
            if source_labels not in existing["sourceLabels"]:
                existing["sourceLabels"].append(source_labels)
            existing["sourceLabels"].sort(key=lambda labels: tuple(str(labels.get(k) or '') for k in ('descriptor', 'ann_type', 'cat', 'source_endpoint')))
            existing["classification"] = classify_filing(existing)
            continue
        row["classification"] = classify_filing(row)
        row.setdefault("sourceEndpoints", [source] if source else [])
        row.setdefault("sourceLabels", [{k: row.get(k) for k in ("source_endpoint", "descriptor", "ann_type", "cat")}])
        row["filingId"] = hashlib.sha256(repr(identity + (str(row.get('news_id') or '') if not url else '',)).encode()).hexdigest()[:24]
        result.append(row)
        if url:
            seen[identity] = row
    return result
