"use strict";

const SENSITIVE_KEY =
  /(authorization|cookie|password|passwd|secret|token|api[-_]?key|passkey|download[-_]?url)/i;

const redactUrl = (value) => {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return "[REDACTED_URL]";
  }
};

const redactString = (value) => String(value)
  .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
  .replace(
    /\b(token|api[-_]?key|passkey|password|secret)\b(["']?\s*[:=]\s*["']?)[^&,\s"'}]+/gi,
    "$1$2[REDACTED]"
  )
  .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url))
  .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]")
  .replace(/\/home\/[^/\s]+/g, "/home/[REDACTED]");

const redact = (value, key = "", seen = new WeakSet()) => {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, "", seen));
  return Object.fromEntries(
    Object.entries(value).map(([itemKey, item]) => [itemKey, redact(item, itemKey, seen)])
  );
};

module.exports = { SENSITIVE_KEY, redact, redactString, redactUrl };
