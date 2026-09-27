import { sanitizeExecutionOutput } from "../execution/sanitize.js";

/**
 * Shared-plane text redaction. Everything projected into the provider-neutral
 * plane passes through here: token/credential patterns are redacted, private
 * key material rejects the whole text, local paths are masked, and the result
 * is bounded. Hidden chain-of-thought is structurally excluded by the adapters
 * (only visible user instructions and assistant final responses are ever
 * projected) — this layer is the content-level backstop.
 */
export function visibleText(value: unknown, maxChars = 4000): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const sanitized = sanitizeExecutionOutput(value);
  if (!sanitized.allowed) return null; // private key material etc. → never projected
  const masked = sanitized.text
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+/g, "[local-path]")
    .replace(/\/(?:Users|home|private|tmp|var)\/[^\s"'`<>]+/g, "[local-path]");
  const trimmed = masked.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…[truncated]`;
}
