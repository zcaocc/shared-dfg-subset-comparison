from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from backend.auth import require_api_token
from backend.data import load_cases
from backend.mining import case_matches, compute_dfg

app = FastAPI()


class MineRequest(BaseModel):
    subsets: list[dict[str, Any]]
    miner: str | None = "directly-follows"


@app.post("/")
@app.post("/api/mine")
def mine(request: MineRequest, http_request: Request) -> dict[str, Any]:
    require_api_token(http_request)
    subset_dfgs = []
    if not request.subsets:
        return {
            "engine": "vercel-python-dfg",
            "miner": request.miner or "directly-follows",
            "subsetDfgs": subset_dfgs,
        }

    for subset in request.subsets:
        if not subset.get("id"):
            raise HTTPException(status_code=400, detail="Each subset must include an id.")

    cases = load_cases(http_request)
    for subset in request.subsets:
        matched_cases = [case for case in cases if case_matches(case, subset)]
        subset_dfgs.append(compute_dfg(subset, matched_cases))

    return {
        "engine": "vercel-python-dfg",
        "miner": request.miner or "directly-follows",
        "subsetDfgs": subset_dfgs,
    }
