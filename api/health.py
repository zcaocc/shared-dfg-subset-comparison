from fastapi import FastAPI

from backend.auth import api_auth_enabled

app = FastAPI()


@app.get("/")
@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "engine": "vercel-python-fastapi",
        "authRequired": api_auth_enabled(),
        "capabilities": {
            "mine": True,
            "layout": True,
        },
    }
