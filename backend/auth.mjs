import { timingSafeEqual } from "node:crypto";

export function apiAuthEnabled() {
  return Boolean(process.env.PMT_API_TOKEN);
}

function tokensMatch(supplied, expected) {
  const suppliedBuffer = Buffer.from(String(supplied));
  const expectedBuffer = Buffer.from(String(expected));
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export function requireApiToken(req, res) {
  const expected = process.env.PMT_API_TOKEN;
  if (!expected) return true;

  const authHeader = String(req.headers.authorization ?? "");
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const supplied = String(req.headers["x-pmt-api-token"] ?? bearerToken);
  if (supplied && tokensMatch(supplied, expected)) return true;

  res.status(401).json({ error: "Valid API token required." });
  return false;
}
