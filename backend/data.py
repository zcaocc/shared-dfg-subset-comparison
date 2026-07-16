from __future__ import annotations

import csv
import io
import os
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urljoin
from urllib.request import urlopen

from fastapi import HTTPException, Request

ROOT = Path(__file__).resolve().parents[1]
ATTRIBUTES_CSV = ROOT / "public" / "data" / "attributes.csv"
EVENTLOG_CSV = ROOT / "public" / "data" / "eventlog.csv"

# Frontend schema keys are the canonical contract. CSV aliases only live here.
CASE_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "caseId": ("item_id", "case_id", "case:concept:name"),
    "salesChannel": ("sales_channel", "salesChannel"),
    "maturityStage": ("maturity_stage", "maturityStage"),
    "inventoryCategory": ("inventory_category", "inventoryCategory"),
    "reserveStatus": ("reserve_status", "reserveStatus"),
    "market": ("market",),
    "salesCompany": ("sales_company", "salesCompany"),
    "transportationTimeDays": ("transportation_time_days", "transportationTimeDays"),
    "advanceNoticeTimeDays": ("advance_notice_time_days", "advanceNoticeTimeDays"),
    "caseDurationHours": ("case_duration_hours", "caseDurationHours"),
    "purchaseOrderDate": ("purchase_order_date", "purchaseOrderDate"),
    "dateOfArrivalAtPort": ("date_of_arrival_at_port", "dateOfArrivalAtPort", "arrival_at_port", "arrivalAtPortDate"),
    "dateOfClearance": ("date_of_clearance", "dateOfClearance"),
    "dateOfCustomerDelivery": ("date_of_customer_delivery", "dateOfCustomerDelivery", "customer_delivery_date", "customerDeliveryDate"),
}

NUMERIC_CASE_FIELDS = {"transportationTimeDays", "advanceNoticeTimeDays", "caseDurationHours"}
DATE_CASE_FIELDS = {"purchaseOrderDate", "dateOfArrivalAtPort", "dateOfClearance", "dateOfCustomerDelivery"}


def parse_number(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    candidates = [text, text.replace("Z", "+00:00")]
    for candidate in candidates:
        try:
            dt = datetime.fromisoformat(candidate)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError:
            pass
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y/%m/%d", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def to_iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def text_value(row: dict[str, str], *keys: str) -> str | None:
    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def normalize_case(row: dict[str, str]) -> dict[str, Any]:
    case: dict[str, Any] = {}
    for field, aliases in CASE_FIELD_ALIASES.items():
        raw_value = text_value(row, *aliases)
        if field in NUMERIC_CASE_FIELDS:
            case[field] = parse_number(raw_value)
        elif field in DATE_CASE_FIELDS:
            case[field] = to_iso(parse_timestamp(raw_value))
        else:
            case[field] = raw_value
    return case


def deployment_base_url(request: Request | None) -> str | None:
    if request is not None:
        return str(request.base_url)
    vercel_url = os.environ.get("VERCEL_URL")
    if vercel_url:
        return f"https://{vercel_url}/"
    return None


@lru_cache(maxsize=4)
def fetch_static_csv(url: str) -> str:
    with urlopen(url, timeout=20) as response:
        return response.read().decode("utf-8-sig")


def read_csv_rows(path: Path, filename: str, base_url: str | None) -> list[dict[str, str]]:
    if path.exists():
        with path.open(newline="", encoding="utf-8-sig") as handle:
            return list(csv.DictReader(handle))
    if base_url:
        try:
            text = fetch_static_csv(urljoin(base_url, f"data/{filename}"))
            return list(csv.DictReader(io.StringIO(text)))
        except Exception as error:
            raise HTTPException(status_code=500, detail=f"Static logistics CSV files could not be loaded: {error}") from error
    raise HTTPException(status_code=500, detail="Static logistics CSV files were not found.")


@lru_cache(maxsize=4)
def load_cases_cached(base_url: str | None) -> list[dict[str, Any]]:
    cases_by_id: dict[str, dict[str, Any]] = {}
    for row in read_csv_rows(ATTRIBUTES_CSV, "attributes.csv", base_url):
        case = normalize_case(row)
        if case["caseId"]:
            case["events"] = []
            cases_by_id[case["caseId"]] = case

    for index, row in enumerate(read_csv_rows(EVENTLOG_CSV, "eventlog.csv", base_url)):
        case_id = text_value(row, "item_id", "case_id", "case:concept:name")
        activity = text_value(row, "activity", "concept:name")
        timestamp = parse_timestamp(text_value(row, "op_time", "timestamp", "time:timestamp"))
        if not case_id or not activity or timestamp is None:
            continue
        if case_id not in cases_by_id:
            cases_by_id[case_id] = {"caseId": case_id, "events": []}
        cases_by_id[case_id]["events"].append(
            {
                "activity": activity,
                "timestamp": timestamp,
                "eventId": str(index),
            }
        )

    cases: list[dict[str, Any]] = []
    for case in cases_by_id.values():
        events = sorted(case.get("events", []), key=lambda event: (event["timestamp"], event["activity"]))
        if not events:
            continue
        case["events"] = events
        case["startTime"] = events[0]["timestamp"]
        case["endTime"] = events[-1]["timestamp"]
        if case.get("caseDurationHours") is None:
            case["caseDurationHours"] = (case["endTime"] - case["startTime"]).total_seconds() / 3600
        cases.append(case)
    return cases


def load_cases(request: Request | None = None) -> list[dict[str, Any]]:
    return load_cases_cached(deployment_base_url(request))
