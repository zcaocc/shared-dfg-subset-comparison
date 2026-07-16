import { afterEach, describe, expect, it, vi } from "vitest";

import { apiAuthEnabled, requireApiToken } from "../backend/auth.mjs";

const originalToken = process.env.PMT_API_TOKEN;

function response() {
  return {
    json: vi.fn(),
    status: vi.fn(function status() {
      return this;
    })
  };
}

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.PMT_API_TOKEN;
  } else {
    process.env.PMT_API_TOKEN = originalToken;
  }
});

describe("backend API token guard", () => {
  it("stays disabled when PMT_API_TOKEN is not configured", () => {
    delete process.env.PMT_API_TOKEN;
    const res = response();

    expect(apiAuthEnabled()).toBe(false);
    expect(requireApiToken({ headers: {} }, res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts bearer and explicit token headers", () => {
    process.env.PMT_API_TOKEN = "test-token";

    expect(requireApiToken({ headers: { authorization: "Bearer test-token" } }, response())).toBe(true);
    expect(requireApiToken({ headers: { "x-pmt-api-token": "test-token" } }, response())).toBe(true);
  });

  it("rejects missing or invalid tokens", () => {
    process.env.PMT_API_TOKEN = "test-token";
    const res = response();

    expect(requireApiToken({ headers: { authorization: "Bearer wrong-token" } }, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Valid API token required." });
  });
});
