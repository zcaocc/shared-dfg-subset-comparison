from __future__ import annotations

from collections import defaultdict
from statistics import mean, median
from typing import Any

from backend.data import parse_number, parse_timestamp


def case_attribute(case: dict[str, Any], field: str) -> Any:
    return case.get(field)


def in_range(value: Any, min_value: Any, max_value: Any) -> bool:
    numeric = parse_number(value)
    min_number = parse_number(min_value)
    max_number = parse_number(max_value)
    if numeric is not None and (min_number is not None or max_number is not None):
        if min_number is not None and numeric < min_number:
            return False
        if max_number is not None and numeric > max_number:
            return False
        return True
    text = "" if value is None else str(value)
    if min_value not in (None, "") and text < str(min_value):
        return False
    if max_value not in (None, "") and text > str(max_value):
        return False
    return True


def date_in_range(value: Any, start: Any, end: Any) -> bool:
    value_dt = parse_timestamp(value) if not hasattr(value, "tzinfo") else value
    if value_dt is None:
        return False
    start_dt = parse_timestamp(start) if start not in (None, "") else None
    end_dt = parse_timestamp(end) if end not in (None, "") else None
    if start_dt and value_dt < start_dt:
        return False
    if end_dt and value_dt > end_dt:
        return False
    return True


def case_matches(case: dict[str, Any], subset: dict[str, Any]) -> bool:
    time_window = subset.get("timeWindow") or {}
    if time_window:
        start_in = date_in_range(case.get("startTime"), time_window.get("startFrom"), time_window.get("startTo"))
        end_in = date_in_range(case.get("endTime"), time_window.get("endFrom"), time_window.get("endTo"))
        if time_window.get("invertStartRange"):
            start_in = not start_in
        if time_window.get("invertEndRange"):
            end_in = not end_in
        if not start_in or not end_in:
            return False

    duration = subset.get("durationRangeHours")
    if duration and not in_range(case.get("caseDurationHours"), duration.get("min"), duration.get("max")):
        return False

    raw_attribute_filters = subset.get("attributeFilters") or []
    if isinstance(raw_attribute_filters, dict):
        attribute_filters = [{"field": field, "operator": "in", "values": values} for field, values in raw_attribute_filters.items()]
    else:
        attribute_filters = raw_attribute_filters

    for rule in attribute_filters:
        if not isinstance(rule, dict):
            continue
        field = rule.get("field")
        value = case_attribute(case, field)
        if rule.get("operator") == "in":
            values = set(rule.get("values") or [])
            match = value in values
        elif rule.get("operator") == "range":
            match = in_range(value, rule.get("min"), rule.get("max"))
        else:
            match = True
        if rule.get("negated"):
            match = not match
        if not match:
            return False

    activities = [event["activity"] for event in case.get("events", [])]
    activity_set = set(activities)
    for activity in subset.get("requiredActivities") or []:
        if activity not in activity_set:
            return False
    for activity in subset.get("excludedActivities") or []:
        if activity in activity_set:
            return False
    for activity in subset.get("reworkActivities") or []:
        if activities.count(activity) < 2:
            return False
    return True


def waiting_bin(hours: float) -> str:
    days = hours / 24
    if days <= 1:
        return "0-1d"
    if days <= 3:
        return "1-3d"
    if days <= 7:
        return "3-7d"
    if days <= 14:
        return "7-14d"
    return "14d+"


def compute_dfg(subset: dict[str, Any], cases: list[dict[str, Any]]) -> dict[str, Any]:
    subset_id = subset["id"]
    total_events = sum(len(case.get("events", [])) for case in cases)
    total_cases = len(cases)
    node_event_counts: dict[str, int] = defaultdict(int)
    node_case_ids: dict[str, set[str]] = defaultdict(set)
    node_positions: dict[str, list[float]] = defaultdict(list)
    edge_counts: dict[str, int] = defaultdict(int)
    edge_case_ids: dict[str, set[str]] = defaultdict(set)
    edge_waits: dict[str, list[float]] = defaultdict(list)

    for case in cases:
        case_id = case["caseId"]
        events = case.get("events", [])
        activities = [event["activity"] for event in events]
        unique_activities = set(activities)
        for index, event in enumerate(events):
            activity = event["activity"]
            node_event_counts[activity] += 1
            node_positions[activity].append(index / max(1, len(events) - 1))
        for activity in unique_activities:
            node_case_ids[activity].add(case_id)

        sequence = [{"activity": "Start", "timestamp": events[0]["timestamp"]}, *events, {"activity": "End", "timestamp": events[-1]["timestamp"]}]
        for left, right in zip(sequence, sequence[1:]):
            key = f"{left['activity']}->{right['activity']}"
            edge_counts[key] += 1
            edge_case_ids[key].add(case_id)
            edge_waits[key].append(max(0, (right["timestamp"] - left["timestamp"]).total_seconds() / 3600))

    node_event_counts["Start"] = total_cases
    node_event_counts["End"] = total_cases
    node_case_ids["Start"] = {case["caseId"] for case in cases}
    node_case_ids["End"] = {case["caseId"] for case in cases}
    node_positions["Start"] = [0]
    node_positions["End"] = [1]

    nodes = []
    for activity in sorted(node_event_counts.keys()):
        case_count = len(node_case_ids[activity])
        event_count = node_event_counts[activity]
        nodes.append(
            {
                "activity": activity,
                "metrics": {
                    "caseCount": case_count,
                    "eventCount": event_count,
                    "frequencyShare": event_count / total_events if total_events else 0,
                    "caseShare": case_count / total_cases if total_cases else 0,
                    "avgPosition": mean(node_positions[activity]) if node_positions[activity] else 0,
                },
            }
        )

    edges = []
    total_edge_count = max(1, sum(edge_counts.values()))
    for key in sorted(edge_counts.keys()):
        source, target = key.split("->", 1)
        waits = edge_waits[key]
        count = edge_counts[key]
        case_count = len(edge_case_ids[key])
        bins = [0 for _ in range(10)]
        for wait in waits:
            days = wait / 24
            index = 9 if days >= 90 else max(0, min(8, int(days // 10)))
            bins[index] += 1
        edges.append(
            {
                "id": f"{source}__{target}",
                "source": source,
                "target": target,
                "metrics": {
                    "count": count,
                    "caseCount": case_count,
                    "frequencyShare": count / total_edge_count,
                    "caseShare": case_count / total_cases if total_cases else 0,
                    "avgWaitingHours": mean(waits) if waits else None,
                    "medianWaitingHours": median(waits) if waits else None,
                    "sumWaitingHours": sum(waits) if waits else None,
                    "waitingTimeBinsHours": bins,
                },
            }
        )

    duration_values = [case.get("caseDurationHours") or 0 for case in cases]
    transport_values = [case["transportationTimeDays"] for case in cases if case.get("transportationTimeDays") is not None]
    notice_values = [case["advanceNoticeTimeDays"] for case in cases if case.get("advanceNoticeTimeDays") is not None]
    summary = {
        "subsetId": subset_id,
        "caseCount": total_cases,
        "eventCount": total_events,
        "avgDurationHours": mean(duration_values) if duration_values else 0,
        "medianCaseDurationHours": median(duration_values) if duration_values else 0,
        "avgCaseDurationHours": mean(duration_values) if duration_values else 0,
        "avgTransportationTimeDays": mean(transport_values) if transport_values else None,
        "avgAdvanceNoticeTimeDays": mean(notice_values) if notice_values else None,
    }

    return {
        "subset": subset,
        "metrics": summary,
        "nodes": nodes,
        "edges": edges,
    }
