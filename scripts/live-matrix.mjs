#!/usr/bin/env node
// Explicit live-only matrix runner. Offline npm test never contacts these endpoints.
// node scripts/live-matrix.mjs --config matrix.json --output /tmp/matrix-result.json
// node scripts/live-matrix.mjs --config matrix.json --dry-run
// { "schemaVersion":1, "defaults":{"contextWindowTokens":32768,"maxIterations":10},
//   "cases":[{"id":"local-qwen","baseUrl":"http://localhost:11434/api/chat",
//     "model":"qwen:fixed-tag","modelRevision":"sha256:declared-digest",
//     "profile":{"reasoningReplay":"thinking"},"apiKeyEnv":"MODEL_API_KEY"}] }
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const script = fileURLToPath(new URL("./live-e2e.mjs", import.meta.url));
const fields = new Set([
  "id",
  "baseUrl",
  "model",
  "modelRevision",
  "profile",
  "timeouts",
  "contextWindowTokens",
  "maxOutputTokens",
  "maxIterations",
  "maxToolCalls",
  "maxRunTokens",
  "maxRunMs",
  "only",
  "apiKeyEnv",
  "maxCaseMs",
]);
const flags = {
  modelRevision: "model-revision",
  contextWindowTokens: "context-window",
  maxOutputTokens: "max-output-tokens",
  maxIterations: "max-iterations",
  maxToolCalls: "max-tool-calls",
  maxRunTokens: "max-run-tokens",
  maxRunMs: "max-run-ms",
  only: "only",
  apiKeyEnv: "api-key-env",
};
const object = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function matrixCases(config) {
  if (
    !object(config) ||
    config.schemaVersion !== 1 ||
    !Array.isArray(config.cases) ||
    !config.cases.length ||
    config.cases.length > 100
  )
    throw new Error("Expected schemaVersion: 1 and 1–100 cases");
  if (config.defaults !== undefined && !object(config.defaults))
    throw new Error("defaults must be an object");
  const seen = new Set();
  return config.cases.map((raw) => {
    if (!object(raw)) throw new Error("Each case must be an object");
    const entry = { ...config.defaults, ...raw };
    for (const key of Object.keys(entry))
      if (!fields.has(key)) throw new Error(`Unknown matrix field: ${key}`);
    if (
      typeof entry.id !== "string" ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(entry.id) ||
      seen.has(entry.id)
    )
      throw new Error(
        "Case ids must be unique, with 1–100 letters, numbers, dots, underscores, or hyphens",
      );
    seen.add(entry.id);
    if (
      typeof entry.baseUrl !== "string" ||
      !/^https?:\/\//.test(entry.baseUrl)
    )
      throw new Error(`${entry.id}: baseUrl must be HTTP(S)`);
    const url = new URL(entry.baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error(
        `${entry.id}: put credentials in apiKeyEnv; baseUrl must have no credentials, query, or fragment`,
      );
    if (typeof entry.model !== "string" || !entry.model.trim())
      throw new Error(`${entry.id}: model is required`);
    for (const field of ["modelRevision", "only", "apiKeyEnv"])
      if (
        entry[field] !== undefined &&
        (typeof entry[field] !== "string" || !entry[field].trim())
      )
        throw new Error(`${entry.id}: ${field} must be a non-empty string`);
    if (entry.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.apiKeyEnv))
      throw new Error(`${entry.id}: invalid apiKeyEnv`);
    for (const field of [
      "contextWindowTokens",
      "maxOutputTokens",
      "maxIterations",
      "maxToolCalls",
      "maxRunTokens",
      "maxRunMs",
      "maxCaseMs",
    ])
      if (
        entry[field] !== undefined &&
        (!Number.isSafeInteger(entry[field]) ||
          entry[field] < (field === "maxToolCalls" ? 0 : 1))
      )
        throw new Error(
          `${entry.id}: ${field} must be a positive integer${field === "maxToolCalls" ? " or zero" : ""}`,
        );
    for (const field of ["profile", "timeouts"])
      if (entry[field] !== undefined && !object(entry[field]))
        throw new Error(`${entry.id}: ${field} must be an object`);
    return entry;
  });
}

export function liveArgs(entry, dryRun = false) {
  const args = [
    "--import",
    "tsx",
    script,
    "--base",
    entry.baseUrl,
    "--model",
    entry.model,
    "--json",
  ];
  for (const [field, flag] of Object.entries(flags))
    if (entry[field] !== undefined)
      args.push(`--${flag}`, String(entry[field]));
  for (const field of ["profile", "timeouts"])
    if (entry[field] !== undefined)
      args.push(`--${field}-json`, JSON.stringify(entry[field]));
  if (dryRun) args.push("--dry-run");
  return args;
}

function executeCase(entry, dryRun) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, liveArgs(entry, dryRun), {
      cwd: path.dirname(path.dirname(script)),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let failure;
    const timer = setTimeout(() => {
      failure = "Case deadline exceeded";
      child.kill("SIGKILL");
    }, entry.maxCaseMs ?? 1_800_000);
    child.stdout.on("data", (bytes) => {
      stdout += bytes.toString();
      if (stdout.length > 8 * 1024 * 1024) {
        failure = "Machine report exceeds 8 MiB";
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (bytes) => {
      stderr = (stderr + bytes.toString()).slice(-65_536);
    });
    child.on("error", (error) => {
      failure = error.message;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let report;
      try {
        report = JSON.parse(stdout);
        if (report.schemaVersion !== 1 || report.kind !== "confucius-live-e2e")
          throw new Error("Unsupported report contract");
      } catch (error) {
        failure ??= `Invalid machine report: ${error.message}`;
      }
      resolve({
        id: entry.id,
        ok: code === 0 && !failure,
        exitCode: code,
        signal,
        elapsedMs: Date.now() - started,
        ...(report ? { report } : {}),
        ...(failure ? { error: failure } : {}),
        ...(code !== 0 || failure ? { stderr } : {}),
      });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (!flag("config"))
    throw new Error(
      "Pass --config matrix.json; use --dry-run for offline validation",
    );
  const entries = matrixCases(
    JSON.parse(await readFile(flag("config"), "utf8")),
  );
  // Validate every resolved profile and deadline with the same executable first.
  // --dry-run performs no model requests, including when a later case is invalid.
  const validation = [];
  for (const entry of entries) validation.push(await executeCase(entry, true));
  if (validation.some((entry) => !entry.ok)) {
    process.stdout.write(
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "confucius-live-matrix",
          validationFailed: true,
          cases: validation,
        },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 1;
    return;
  }
  const dryRun = args.includes("--dry-run");
  const cases = [];
  if (dryRun) cases.push(...validation);
  else
    for (const entry of entries) {
      console.error(`Live matrix: ${entry.id}`);
      cases.push(await executeCase(entry, false));
    }
  const report = {
    schemaVersion: 1,
    kind: "confucius-live-matrix",
    createdAt: new Date().toISOString(),
    dryRun,
    cases,
    summary: {
      total: cases.length,
      passed: cases.filter((entry) => entry.ok).length,
      failed: cases.filter((entry) => !entry.ok).length,
    },
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (flag("output")) await writeFile(flag("output"), json, "utf8");
  process.stdout.write(json);
  process.exitCode = report.summary.failed ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
