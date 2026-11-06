import { StreamProtocolError } from "./client.js";

export function parseToolArguments(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json.trim() || "{}");
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Report protocol failure without echoing potentially sensitive arguments. */ }
  throw new StreamProtocolError("Tool arguments must be a complete JSON object");
}
