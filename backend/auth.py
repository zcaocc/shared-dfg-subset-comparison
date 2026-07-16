from __future__ import annotations

import os
import secrets

from fastapi import HTTPException, Request

API_TOKEN_ENV = "PMT_API_TOKEN"


def api_auth_enabled() -> bool:
    return bool(os.environ.get(API_TOKEN_ENV))


def require_api_token(request: Request) -> None:
    expected = os.environ.get(API_TOKEN_ENV)
    if not expected:
        return

    auth_header = request.headers.get("authorization", "")
    bearer_token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else ""
    supplied = request.headers.get("x-pmt-api-token") or bearer_token
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Valid API token required.")
