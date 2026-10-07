"""Event, announcement, and news-feed enrichment for the master stock JSON."""

import glob
import os
from datetime import datetime, timedelta

from pipeline_utils import BASE_DIR, load_json, save_json


def add_unique_event(event_map, symbol, event):
    if not symbol:
        return
    event_map.setdefault(symbol, [])
    if event not in event_map[symbol]:
        event_map[symbol].append(event)


def collect_surveillance_events(asm_items):
    event_map = {}
    for item in asm_items:
        symbol = item.get("Symbol")
        stage = item.get("Stage", "")
        if "LTASM" in stage:
            add_unique_event(event_map, symbol, "★: LTASM")
        elif "STASM" in stage:
            add_unique_event(event_map, symbol, "★: STASM")
    return event_map


def collect_upcoming_action_events(upcoming_items, today=None):
    event_map = {}
    today = today or datetime.now()
    action_limit = today + timedelta(days=30)
    results_limit = today + timedelta(days=14)

    for event in upcoming_items:
        symbol = event.get("Symbol")
        event_type = event.get("Type", "")
        date_text = event.get("ExDate")
        if not symbol or not date_text:
            continue

        try:
            event_date = datetime.strptime(date_text, "%Y-%m-%d")
        except Exception:
            continue

        if not today.date() <= event_date.date() <= action_limit.date():
            continue

        date_label = event_date.strftime("%d-%b")
        if "QUARTERLY" in event_type and event_date.date() <= results_limit.date():
            add_unique_event(event_map, symbol, f"⏰: Results ({date_label})")
        elif "DIVIDEND" in event_type:
            add_unique_event(event_map, symbol, f"💸: Dividend ({date_label})")
        elif "BONUS" in event_type:
            add_unique_event(event_map, symbol, f"🎁: Bonus ({date_label})")
        elif "SPLIT" in event_type:
            add_unique_event(event_map, symbol, f"✂️: Split ({date_label})")
        elif "RIGHTS" in event_type:
            add_unique_event(event_map, symbol, f"📈: Rights ({date_label})")

    return event_map


def collect_upcoming_results_events(calendar, today=None):
    """Render the selected calendar date without changing its event meaning."""
    event_map = {}
    today = today or datetime.now()
    limit = today + timedelta(days=14)
    for event in (calendar.get("events", []) if isinstance(calendar, dict) else []):
        symbol, date_text = event.get("symbol"), event.get("scheduled_date")
        try:
            event_date = datetime.strptime(date_text, "%Y-%m-%d")
        except (TypeError, ValueError):
            continue
        if not symbol or not today.date() <= event_date.date() <= limit.date():
            continue
        label = ("Results board meeting" if event.get("event_type") == "RESULTS_BOARD_MEETING"
                 else "Results announcement" if event.get("event_type") == "QUARTERLY_RESULT_ANNOUNCEMENT"
                 else "Results scheduled" if event.get("event_type") == "RESULTS_SCHEDULED"
                 else None)
        if label:
            add_unique_event(event_map, symbol, f"⏰: {label} ({event_date:%d-%b})")
    return event_map


def collect_upcoming_nse_action_events(ledger, today=None):
    """Render the official NSE ledger into the legacy event-marker vocabulary."""
    actions = ledger.get("actions", []) if isinstance(ledger, dict) else []
    translated = []
    for action in actions:
        categories = {str(category).lower() for category in action.get("categories", [])}
        if "dividend" in categories:
            action_type = "DIVIDEND"
        elif "bonus" in categories:
            action_type = "BONUS"
        elif "split" in categories or "consolidation" in categories:
            action_type = "SPLIT"
        elif "rights" in categories:
            action_type = "RIGHTS"
        else:
            continue
        translated.append({
            "Symbol": action.get("symbol"),
            "Type": action_type,
            "ExDate": action.get("exDate"),
        })
    return collect_upcoming_action_events(translated, today=today)


def collect_circuit_revision_events(items):
    event_map = {}
    for item in items:
        symbol = item.get("Symbol")
        from_band = item.get("From")
        to_band = item.get("To")
        if not symbol or not from_band or not to_band:
            continue
        try:
            if float(to_band) < float(from_band):
                add_unique_event(event_map, symbol, "#: -ve Circuit Limit Revision")
            elif float(to_band) > float(from_band):
                add_unique_event(event_map, symbol, "#: +ve Circuit Limit Revision")
        except Exception:
            continue
    return event_map


def collect_deal_events(deals, today=None):
    event_map = {}
    today = today or datetime.now()
    recent_limit = today - timedelta(days=7)

    for deal in deals:
        symbol = deal.get("sym")
        deal_type = deal.get("deal", "")
        date_text = deal.get("date", "").split(" ")[0]
        if not symbol or not date_text:
            continue
        try:
            deal_date = datetime.strptime(date_text, "%Y-%m-%d")
        except Exception:
            continue

        if deal_date >= recent_limit and ("BLOCK" in deal_type or "BULK" in deal_type):
            add_unique_event(event_map, symbol, "📦: Block Deal")

    return event_map


def is_insider_trade_filing(item):
    desc = (item.get("descriptor") or "").lower()
    caption = (item.get("caption") or "").lower()
    category = (item.get("cat") or "").lower()
    body = (item.get("news_body") or "").lower()
    full_text = f"{desc} {caption} {category} {body}"
    trade_keywords = [
        "regulation 7(2)",
        "reg 7(2)",
        "inter-se transfer",
        "form c",
        "continual disclosure",
    ]
    if any(keyword in full_text for keyword in trade_keywords):
        return True
    if "insider trading" in full_text or "sebi (pit)" in full_text or "sebi pit" in full_text:
        return "trading window" not in full_text and "closure" not in full_text
    return False


def top_regulatory_headlines(items):
    headlines = []
    for item in items[:5]:
        headline = item.get("caption") or item.get("descriptor") or item.get("news_body") or "N/A"
        headlines.append(
            {
                "Date": item.get("news_date", "N/A"),
                "Headline": " ".join(headline.split()),
                "URL": item.get("file_url") or "N/A",
            }
        )
    return headlines


def collect_filing_events_and_headlines(filing_files, today=None):
    event_map = {}
    news_map = {}
    today = today or datetime.now()
    recent_limit = today - timedelta(days=15)

    for filing_file in filing_files:
        symbol = os.path.basename(filing_file).replace("_filings.json", "")
        try:
            items = load_json(filing_file).get("data", [])
        except Exception:
            continue

        if not items:
            continue

        news_map[symbol] = top_regulatory_headlines(items)

        for item in items:
            date_text = item.get("news_date", "").split(" ")[0]
            if not date_text:
                continue
            try:
                news_date = datetime.strptime(date_text, "%Y-%m-%d")
            except Exception:
                continue

            if news_date >= recent_limit and is_insider_trade_filing(item):
                add_unique_event(event_map, symbol, "🔑: Insider Trading")
                break

    return event_map, news_map


def merge_announcement_events_and_headlines(announcements, event_map, news_map, today=None):
    today = today or datetime.now()
    marker_limit = today - timedelta(days=7)

    for announcement in announcements:
        symbol = announcement.get("Symbol")
        event_text = announcement.get("Event") or ""
        event_type = announcement.get("Type", "")
        date_text = announcement.get("Date", "")
        if not symbol or not date_text:
            continue

        try:
            announcement_date = datetime.strptime(date_text.split(" ")[0], "%Y-%m-%d")
        except Exception:
            continue

        if announcement_date >= marker_limit:
            if "results are out" in event_text.lower() or event_type == "Results Update":
                add_unique_event(event_map, symbol, "📊: Results Recently Out")

        news_map.setdefault(symbol, [])
        exists = any(event_text.lower() in existing["Headline"].lower() for existing in news_map[symbol])
        if not exists:
            news_map[symbol].insert(0, {"Date": date_text, "Headline": event_text, "URL": "N/A"})
            news_map[symbol] = news_map[symbol][:5]


def collect_market_news(news_files):
    news_feed_map = {}
    for news_file in news_files:
        try:
            data = load_json(news_file)
        except Exception:
            continue

        symbol = data.get("Symbol")
        news_list = data.get("News", [])
        if not symbol or not news_list:
            continue

        news_feed_map[symbol] = [
            {
                "Title": item.get("Title"),
                "Sentiment": item.get("Sentiment"),
                "Date": item.get("PublishDate"),
            }
            for item in news_list[:5]
        ]
    return news_feed_map


def merge_event_maps(*maps):
    merged = {}
    for event_map in maps:
        for symbol, events in event_map.items():
            for event in events:
                add_unique_event(merged, symbol, event)
    return merged


def apply_events_to_master(master_data, event_map, news_map, news_feed_map):
    for stock in master_data:
        symbol = stock.get("Symbol")
        events = event_map.get(symbol, [])
        stock["Event Markers"] = " | ".join(events) if events else "N/A"
        stock["Recent Announcements"] = news_map.get(symbol, [])[:5]
        stock["News Feed"] = news_feed_map.get(symbol, [])
    return master_data


def optional_json(path, default):
    return load_json(path) if os.path.exists(path) else default


def map_refined_events(base_dir=BASE_DIR):
    master_file = os.path.join(base_dir, "all_stocks_fundamental_analysis.json")
    nse_actions_file = os.path.join(base_dir, "nse_corporate_actions.json")
    earnings_events_file = os.path.join(base_dir, "upcoming_earnings_events.json")
    calendar_file = os.path.join(base_dir, "earnings_calendar.json")
    filings_dir = os.path.join(base_dir, "company_filings")
    asm_file = os.path.join(base_dir, "nse_asm_list.json")
    deals_file = os.path.join(base_dir, "bulk_block_deals.json")
    circuit_revision_file = os.path.join(base_dir, "incremental_price_bands.json")
    announcement_file = os.path.join(base_dir, "all_company_announcements.json")
    market_news_dir = os.path.join(base_dir, "market_news")

    if not os.path.exists(master_file):
        print(f"Error: {master_file} not found.")
        return False

    print("Loading master data...")
    master_data = load_json(master_file)

    print("Processing Surveillance (★: LTASM, ★: STASM)...")
    surveillance_events = collect_surveillance_events(optional_json(asm_file, []))

    print("Processing official NSE corporate actions (💸, ✂️, 🎁, 📈)...")
    action_events = collect_upcoming_nse_action_events(optional_json(nse_actions_file, {}))
    print("Processing merged upcoming-results calendar (⏰)...")
    calendar = optional_json(calendar_file, None)
    calendar_events = collect_upcoming_results_events(calendar) if calendar is not None else {}
    if calendar is None:
        print("Processing legacy earnings-event fallback (⏰)...")
    earnings_events = collect_upcoming_action_events(optional_json(earnings_events_file, [])) if calendar is None else {}

    print("Processing Circuit Revisions (#: -ve/ +ve Circuit Limit Revision)...")
    circuit_events = collect_circuit_revision_events(optional_json(circuit_revision_file, []))

    print("Processing Deals (📦: Block Deal)...")
    deal_events = collect_deal_events(optional_json(deals_file, []))

    print("Processing Insider Trades & Recent Headlines...")
    filing_files = glob.glob(os.path.join(filings_dir, "*_filings.json")) if os.path.exists(filings_dir) else []
    filing_events, news_map = collect_filing_events_and_headlines(filing_files)

    event_map = merge_event_maps(surveillance_events, action_events, calendar_events, earnings_events, circuit_events, deal_events, filing_events)

    print("Processing Recent Results & Live Headlines (📊)...")
    if os.path.exists(announcement_file):
        merge_announcement_events_and_headlines(load_json(announcement_file), event_map, news_map)

    print("Processing Market News Feed (Sentiment Analysis)...")
    news_files = glob.glob(os.path.join(market_news_dir, "*_news.json")) if os.path.exists(market_news_dir) else []
    news_feed_map = collect_market_news(news_files)

    print(f"Applying markers, headlines, and news to {len(master_data)} stocks...")
    save_json(master_file, apply_events_to_master(master_data, event_map, news_map, news_feed_map), ensure_ascii=False)

    print("Successfully updated master JSON with comprehensive markers.")
    return True
