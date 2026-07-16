from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from api.mine import app as mine_app
from backend.auth import require_api_token
from backend.data import load_cases_cached, normalize_case, parse_timestamp
from backend.mining import case_matches, compute_dfg


NETHERLANDS_PHASE3_SUBSET = {
    "id": "direct-netherlands-phase3",
    "name": "Netherlands Phase 3",
    "attributeFilters": [
        {"field": "salesChannel", "operator": "in", "values": ["Direct Sales"]},
        {"field": "market", "operator": "in", "values": ["Netherlands"]},
        {"field": "inventoryCategory", "operator": "in", "values": ["Standard"]},
        {"field": "dateOfClearance", "operator": "range", "min": "2025-08-04", "max": "2026-04-03"},
        {"field": "dateOfArrivalAtPort", "operator": "range", "min": "2026-01-14", "max": "2026-03-23"},
    ],
    "timeWindow": {
        "endFrom": "2026-01-15T00:00:00",
        "endTo": "2026-04-22T23:59:59",
    },
    "requiredActivities": [],
    "excludedActivities": [],
    "reworkActivities": [],
}


class BackendContractTest(unittest.TestCase):
    def test_minute_timestamp_format_remains_supported(self) -> None:
        timestamp = parse_timestamp("2025/4/30 08:00")
        self.assertIsNotNone(timestamp)
        self.assertEqual(timestamp.isoformat(), "2025-04-30T08:00:00+00:00")

    def test_normalized_case_uses_frontend_schema_field_names(self) -> None:
        case = normalize_case(
            {
                "item_id": "case-1",
                "date_of_arrival_at_port": "2026-01-15",
                "date_of_customer_delivery": "2026-04-18",
            }
        )
        self.assertEqual(case["dateOfArrivalAtPort"], "2026-01-15T00:00:00Z")
        self.assertEqual(case["dateOfCustomerDelivery"], "2026-04-18T00:00:00Z")
        self.assertNotIn("arrivalAtPortDate", case)
        self.assertNotIn("customerDeliveryDate", case)

    def test_netherlands_phase3_backend_subset_is_not_empty(self) -> None:
        cases = load_cases_cached(None)
        matched_cases = [case for case in cases if case_matches(case, NETHERLANDS_PHASE3_SUBSET)]
        dfg = compute_dfg(NETHERLANDS_PHASE3_SUBSET, matched_cases)

        self.assertEqual(dfg["metrics"]["caseCount"], 158)
        self.assertEqual(dfg["metrics"]["eventCount"], 2150)
        self.assertGreaterEqual(len(dfg["nodes"]), 20)
        self.assertGreaterEqual(len(dfg["edges"]), 90)

    def test_optional_api_token_guard(self) -> None:
        class OpenRequest:
            headers = {}

        with patch.dict(os.environ, {"PMT_API_TOKEN": ""}):
            require_api_token(OpenRequest())

        class Request:
            headers = {"authorization": "Bearer test-token"}

        with patch.dict(os.environ, {"PMT_API_TOKEN": "test-token"}):
            require_api_token(Request())

        class HeaderRequest:
            headers = {"x-pmt-api-token": "test-token"}

        with patch.dict(os.environ, {"PMT_API_TOKEN": "test-token"}):
            require_api_token(HeaderRequest())

        class BadRequest:
            headers = {}

        with patch.dict(os.environ, {"PMT_API_TOKEN": "test-token"}):
            with self.assertRaises(HTTPException):
                require_api_token(BadRequest())

    def test_mine_endpoint_requires_configured_api_token(self) -> None:
        client = TestClient(mine_app)

        with patch.dict(os.environ, {"PMT_API_TOKEN": "test-token"}):
            missing = client.post("/api/mine", json={"subsets": []})
            self.assertEqual(missing.status_code, 401)

            invalid = client.post("/api/mine", json={"subsets": []}, headers={"Authorization": "Bearer wrong-token"})
            self.assertEqual(invalid.status_code, 401)

            valid = client.post("/api/mine", json={"subsets": []}, headers={"Authorization": "Bearer test-token"})
            self.assertEqual(valid.status_code, 200)


if __name__ == "__main__":
    unittest.main()
