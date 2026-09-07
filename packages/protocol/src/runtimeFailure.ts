export interface RuntimeFailure {
  retryable: boolean;
  code?: string;
  message: string;
}
/** Decode provider/transport failures, never tool output or assistant prose. */
export function runtimeFailure(value: unknown): RuntimeFailure {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : record;
  const data =
    nested.data && typeof nested.data === "object"
      ? (nested.data as Record<string, unknown>)
      : nested;
  const info =
    nested.codexErrorInfo ?? data.codexErrorInfo ?? data.code ?? nested.code;
  const code =
    typeof info === "string"
      ? info
      : info && typeof info === "object"
        ? Object.keys(info)[0]
        : undefined;
  const message = String(
    nested.message ?? record.message ?? value ?? "Runtime failed",
  );
  if (
    code &&
    [
      "unauthorized",
      "badRequest",
      "contextWindowExceeded",
      "sessionBudgetExceeded",
      "usageLimitExceeded",
      "sandboxError",
      "cyberPolicy",
      "misalignmentPolicyViolation",
    ].includes(code)
  )
    return { retryable: false, code, message };
  const detail =
    info && typeof info === "object" && code
      ? ((info as Record<string, unknown>)[code] as Record<string, unknown>)
      : undefined;
  const status = Number(
    detail?.httpStatusCode ?? data.status ?? data.statusCode,
  );
  if ([400, 401, 403, 404, 422].includes(status))
    return { retryable: false, code, message };
  const retryable =
    [408, 429, 500, 502, 503, 504].includes(status) ||
    (!!code &&
      [
        "rateLimitExceeded",
        "serverOverloaded",
        "internalServerError",
        "httpConnectionFailed",
        "responseStreamConnectionFailed",
        "responseStreamDisconnected",
        "responseTooManyFailedAttempts",
        "ECONNRESET",
        "ETIMEDOUT",
        "EPIPE",
      ].includes(code)) ||
    /\b(?:ECONNRESET|ETIMEDOUT|EPIPE|timed out|timeout|connection (?:reset|closed)|stream (?:disconnected|closed)|service unavailable|server overloaded)\b/i.test(
      message,
    );
  return {
    retryable,
    code: code ?? (retryable ? "transport" : undefined),
    message,
  };
}
