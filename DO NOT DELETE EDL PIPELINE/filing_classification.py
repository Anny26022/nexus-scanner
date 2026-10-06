"""Deterministic disclosure topics; labels describe filings, not investment impact."""
from __future__ import annotations

import hashlib
import re
from urllib.parse import urlsplit, urlunsplit

VERSION = 1

# Stable IDs, group, display name, and deliberately specific text rules.
_GROUPS = {
    "results": [("financial_results", "Financial results", r"financial results|integrated filing financial"),
                ("annual_report", "Annual report", r"annual report"),
                ("financial_revision", "Results delay / correction", r"delay(?:ed)? .*financial results|non submission of financial results|restatement|voluntary revision of financial")],
    "board_meetings": [("board_intimation", "Board meeting intimation", r"board meeting intimation|board meeting$"),
                       ("board_outcome", "Board meeting outcome", r"outcome of board meeting|board meeting outcome|outcome without intimation"),
                       ("board_change", "Board meeting change", r"board meeting (?:rescheduled|cancelled)|reschedul.*board meeting")],
    "business": [("general_announcement", "General announcement", r"^general(?: announcements?)?$"),
                 ("order_win", "Order win", r"award of order|receipt of order|bagging.*(?:order|contract)|awarding of orders?"),
                 ("press_release", "Press release", r"press release|media release"),
                 ("business_update", "Business update / Monthly update", r"(?:monthly|quarterly|business) (?:business )?update"),
                 ("investor_presentation", "Investor presentation", r"investor presentation"),
                 ("capex", "Capex / expansion", r"capacity addition|capital expenditure|\bcapex\b|plant expansion"),
                 ("commissioning", "Commercial production / commissioning", r"commercial production|commencement of .*operations|commissioning"),
                 ("regulatory_approval", "Regulatory approval", r"regulatory approval|key licen[cs]es|\busfda\b"),
                 ("product_launch", "Product launch / opening", r"product launch|opening of .*store|launch of .*product"),
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

def classify_filing(filing):
    """Specific labels take precedence over broad body mentions; topics may overlap."""
    label_values = [_text(filing.get(k)) for k in ("descriptor", "ann_type", "cat")]
    labels = " ".join(label_values).strip()
    text = " ".join(_text(filing.get(k)) for k in ("caption", "news_body"))
    label_hits = [key for key, _, _, rx in RULES if any(rx.search(value) for value in label_values)]
    # Supporting text can refine specific labels, but mere mentions of results
    # inside a meeting intimation must not claim the results were announced.
    hits = list(label_hits)
    if not hits or hits == ["general_announcement"]:
        detail = [key for key, _, _, rx in RULES if rx.search(text) and key != "general_announcement"]
        hits = detail or hits
    elif any(key in hits for key in ("board_outcome", "board_intimation", "press_release")):
        wrappers = {"board_intimation", "board_outcome", "board_change", "general_announcement"}
        hits.extend(key for key, _, _, rx in RULES if key not in wrappers and rx.search(text))
    combined = labels + " " + text
    if re.search(r"tax|tribunal|penalty|litigation|court|authority", combined) and "order_win" in hits:
        hits.remove("order_win")
        hits.append("litigation")
    if "esop" in hits and "allotment" in hits:
        hits.remove("allotment")
    if "pledge" in hits and "stake_change" in hits:
        hits.remove("stake_change")
    if "trading_plan" in hits or "trading window" in combined:
        hits = [key for key in hits if key != "insider_transaction"]
    if "board_intimation" in hits:
        hits = [key for key in hits if key != "financial_results"]
    if "board_outcome" in hits or "board_change" in hits:
        hits = [key for key in hits if key != "board_intimation"]
    if "post_action" in hits:
        hits = [key for key in hits if key != "buyback"]
    if len(set(hits)) > 1:
        hits = [key for key in hits if key != "general_announcement"]
    status = "unspecified"
    for name, pattern in (("withdrawn", r"withdrawal|withdrawn"), ("cancelled", r"cancelled|cancellation"),
                          ("revised", r"revised|revision|corrigendum|restatement"),
                          ("completed", r"completed|completion|commissioned"),
                          ("proposed", r"to consider|scheduled|proposal|proposed"),
                          ("approved", r"approved|approval")):
        if re.search(pattern, combined):
            status = name
            break
    document_type = next((key for key in ("board_intimation", "board_outcome", "press_release", "call_transcript", "investor_presentation", "annual_report") if key in hits), "filing")
    hits = sorted(set(hits))
    return {"version": VERSION, "topics": hits or ["unclassified"],
            "documentType": document_type, "status": status,
            "matchedRuleIds": ["v1:" + key for key in hits],
            "method": "predefined_rules", "basis": "source_labels_and_text" if label_hits else "filing_text"}

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
            incoming = classify_filing(row)
            topics = set(existing["classification"]["topics"]) | set(incoming["topics"])
            if len(topics) > 1:
                topics -= {"general_announcement", "unclassified"}
            existing["classification"]["topics"] = sorted(topics)
            existing["classification"]["matchedRuleIds"] = sorted(set(existing["classification"]["matchedRuleIds"] + incoming["matchedRuleIds"]))
            continue
        row["classification"] = classify_filing(row)
        row["sourceEndpoints"] = [source] if source else []
        row["sourceLabels"] = [{k: row.get(k) for k in ("source_endpoint", "descriptor", "ann_type", "cat")}]
        row["filingId"] = hashlib.sha256(repr(identity + (str(row.get('news_id') or '') if not url else '',)).encode()).hexdigest()[:24]
        result.append(row)
        if url:
            seen[identity] = row
    return result
