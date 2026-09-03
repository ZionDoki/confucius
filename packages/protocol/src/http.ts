export const CONFUCIUS_PROTOCOL_VERSION = 1;

export const CONFUCIUS_HTTP_PREFIX = "/confucius/v1";

export const CONFUCIUS_HEALTH_PATH = `${CONFUCIUS_HTTP_PREFIX}/health`;

export const CONFUCIUS_RPC_PATH = `${CONFUCIUS_HTTP_PREFIX}/rpc`;

export const CONFUCIUS_EVENTS_PATH = `${CONFUCIUS_HTTP_PREFIX}/events`;

export const CONFUCIUS_MCP_PATH = `${CONFUCIUS_HTTP_PREFIX}/mcp`;

export const CONFUCIUS_LOOPBACK_ORIGIN = "http://127.0.0.1:23119";

export const MCP_LATEST_PROTOCOL_VERSION = "2025-11-25";

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export function negotiateMcpProtocolVersion(requested: unknown): string {
  return typeof requested === "string" &&
    (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_LATEST_PROTOCOL_VERSION;
}

export interface ConfuciusHealthResponse {
  ok: true;
  name: "confucius";
  version: string;
  protocol: typeof CONFUCIUS_PROTOCOL_VERSION;
}

export function buildHealthResponse(
  version: string,
): ConfuciusHealthResponse {
  return {
    ok: true,
    name: "confucius",
    version,
    protocol: CONFUCIUS_PROTOCOL_VERSION,
  };
}

export function isConfuciusHealthResponse(
  value: unknown,
): value is ConfuciusHealthResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.ok === true &&
    record.name === "confucius" &&
    typeof record.version === "string" &&
    record.protocol === CONFUCIUS_PROTOCOL_VERSION
  );
}
