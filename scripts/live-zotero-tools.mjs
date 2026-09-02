#!/usr/bin/env node

/**
 * Live Zotero tool verification.
 *
 * This is deliberately not a unit-test double: every tool call travels through
 * the running add-on's AgentHost, permission gate, TurnLoop, and Zotero APIs.
 * A tiny deterministic OpenAI-compatible server only chooses the exact tool
 * and arguments, so model sampling cannot silently skip a case.
 */

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  LIBRARY_READ_TOOLS,
  LIBRARY_WRITE_TOOLS,
  MEMORY_READ_TOOLS,
  MEMORY_WRITE_TOOLS,
  PAPER_READ_TOOLS,
  PAPER_WRITE_TOOLS,
} from "@confucius/protocol";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILE_PREFS = resolve(
  ROOT,
  "apps/zotero-addon/.scaffold/profile/prefs.js",
);
const PDF_FIXTURE = resolve(
  ROOT,
  "scripts/fixtures/confucius-tool-e2e-fixture.pdf",
);
const REPORT_PATH = resolve(ROOT, "output/tool-e2e-report.json");
const MOCK_PORT = Number(process.env.CONFUCIUS_E2E_MOCK_PORT || 18765);
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_BASE_URL = `${MOCK_ORIGIN}/v1`;
const CALL_MARKER = "CONFUCIUS_E2E_CALL ";
const ALL_TOOLS = [
  ...LIBRARY_READ_TOOLS,
  ...LIBRARY_WRITE_TOOLS,
  ...PAPER_READ_TOOLS,
  ...PAPER_WRITE_TOOLS,
  ...MEMORY_READ_TOOLS,
  ...MEMORY_WRITE_TOOLS,
];
const READ_ONLY_TOOLS = [
  ...LIBRARY_READ_TOOLS,
  ...PAPER_READ_TOOLS,
  ...MEMORY_READ_TOOLS,
];

if (ALL_TOOLS.length !== 57 || new Set(ALL_TOOLS).size !== 57) {
  throw new Error(
    `Expected 57 unique built-in tools, found ${ALL_TOOLS.length}`,
  );
}

function parseUserPrefs(source) {
  const prefs = new Map();
  const pattern = /user_pref\("([^"]+)",\s*(.+?)\);/g;
  for (const match of source.matchAll(pattern)) {
    try {
      prefs.set(match[1], JSON.parse(match[2]));
    } catch {
      // Ignore unrelated non-JSON preference syntax.
    }
  }
  return prefs;
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function startDeterministicServer(pdfBytes) {
  let callSequence = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", MOCK_ORIGIN);
      if (url.pathname === "/fixture.pdf") {
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": pdfBytes.length,
          "content-disposition": `inline; filename="${basename(PDF_FIXTURE)}"`,
        });
        if (request.method === "HEAD") response.end();
        else response.end(pdfBytes);
        return;
      }
      if (url.pathname === "/v1/models") {
        json(response, 200, {
          object: "list",
          data: [{ id: "confucius-e2e", object: "model" }],
        });
        return;
      }
      if (url.pathname !== "/v1/chat/completions") {
        json(response, 404, { error: "not found" });
        return;
      }
      const body = await requestBody(request);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      let userIndex = -1;
      let specification = null;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "user" || typeof message.content !== "string") {
          continue;
        }
        const markerIndex = message.content.indexOf(CALL_MARKER);
        if (markerIndex < 0) continue;
        userIndex = index;
        specification = JSON.parse(
          message.content.slice(markerIndex + CALL_MARKER.length),
        );
        break;
      }
      const hasToolResult =
        userIndex >= 0 &&
        messages
          .slice(userIndex + 1)
          .some((message) => message?.role === "tool");
      const message =
        specification && !hasToolResult
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_e2e_${++callSequence}`,
                  type: "function",
                  function: {
                    name: String(specification.name),
                    arguments: JSON.stringify(specification.args || {}),
                  },
                },
              ],
            }
          : { role: "assistant", content: "E2E tool call completed." };
      json(response, 200, {
        id: `chatcmpl-e2e-${callSequence}`,
        object: "chat.completion",
        choices: [{ index: 0, finish_reason: "stop", message }],
        usage: { prompt_tokens: 16, completion_tokens: 4, total_tokens: 20 },
      });
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(MOCK_PORT, "127.0.0.1", resolveListen);
  });
  return server;
}

function compactEvidence(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => compactEvidence(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, entry]) => [key, compactEvidence(entry, depth + 1)]),
    );
  }
  return value;
}

function includesText(value, expected) {
  return JSON.stringify(value).toLowerCase().includes(expected.toLowerCase());
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function main() {
  const startedAt = new Date().toISOString();
  const runId = `Confucius E2E ${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")}`;
  const prefs = parseUserPrefs(await readFile(PROFILE_PREFS, "utf8"));
  const pairingToken = String(
    prefs.get("extensions.zotero.confucius.pairingToken") || "",
  );
  const zoteroPort = Number(
    process.env.CONFUCIUS_ZOTERO_PORT ||
      prefs.get("extensions.zotero.httpServer.port") ||
      23119,
  );
  if (!pairingToken) throw new Error("Development pairing token not found");
  const origin = `http://127.0.0.1:${zoteroPort}`;
  const rpcUrl = `${origin}/confucius/v1/rpc`;
  const mcpUrl = `${origin}/confucius/v1/mcp`;
  let rpcId = 0;
  const rpc = async (method, params = {}) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pairingToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method,
        params,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `RPC HTTP ${response.status}`);
    }
    return payload.result;
  };
  const mcp = async (method, params = {}) => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pairingToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method,
        params,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message || `MCP HTTP ${response.status}`);
    }
    return payload.result;
  };

  const matrix = new Map(
    ALL_TOOLS.map((tool) => [
      tool,
      { tool, status: "not_tested", detail: "No result recorded" },
    ]),
  );
  const exercisedArgs = new Map();
  const auxiliary = [];
  const mcpAudit = [];
  let originalConfig;
  let temporaryEndpointId = "";
  let sessionId = "";
  let server;
  let temporaryKnowledgeBaseId = "";

  const record = (tool, status, detail, result) => {
    matrix.set(tool, {
      tool,
      status,
      detail,
      ...(result === undefined ? {} : { evidence: compactEvidence(result) }),
    });
    console.log(`${status.padEnd(19)} ${tool} — ${detail}`);
  };

  const waitForTurn = async (turnId, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const payload = await rpc("session/events", { sessionId });
      const events = (payload.events || []).filter(
        (event) => event.turnId === turnId,
      );
      const terminal = events.find((event) =>
        ["turn_completed", "turn_failed", "turn_aborted"].includes(event.type),
      );
      if (terminal) return { events, terminal };
      if (Date.now() >= deadline) {
        await rpc("session/abort", { sessionId }).catch(() => undefined);
        throw new Error(`Timed out waiting for turn ${turnId}`);
      }
      await delay(100);
    }
  };

  const callAgentTool = async (name, args, timeoutMs) => {
    exercisedArgs.set(name, args);
    const prompt = await rpc("session/prompt", {
      sessionId,
      text: `${CALL_MARKER}${JSON.stringify({ name, args })}`,
    });
    const turn = await waitForTurn(prompt.turnId, timeoutMs);
    const requested = turn.events.filter(
      (event) => event.type === "tool_requested",
    );
    if (requested.length !== 1 || requested[0].payload.toolName !== name) {
      throw new Error(
        `Expected exactly one ${name} request, saw ${requested
          .map((event) => event.payload.toolName)
          .join(", ")}`,
      );
    }
    const resultEvent = turn.events.find(
      (event) => event.type === "tool_result",
    );
    if (!resultEvent) {
      throw new Error(`No tool_result event for ${name}`);
    }
    return resultEvent.payload.result;
  };

  const exercise = async (
    name,
    args,
    {
      validate,
      blockedCodes = [],
      defectCodes = [],
      timeoutMs = 120_000,
      okDetail = "real AgentHost call and assertion passed",
    } = {},
  ) => {
    try {
      const result = await callAgentTool(name, args, timeoutMs);
      if (!result.ok) {
        const blocked = blockedCodes.includes(result.code);
        const defect = defectCodes.includes(result.code);
        record(
          name,
          blocked
            ? "environment_blocked"
            : defect
              ? "functional_defect"
              : "fail",
          `${result.code}: ${result.message}${
            result.toolName !== name
              ? ` (returned as ${result.toolName}, not ${name})`
              : ""
          }`,
          result,
        );
        return result;
      }
      if (result.toolName !== name) {
        record(
          name,
          "functional_defect",
          `tool result was mislabeled as ${result.toolName}`,
          result,
        );
        return result;
      }
      const verdict = validate ? validate(result.data) : true;
      if (verdict === true || verdict === undefined) {
        record(name, "pass", okDetail, result.data);
      } else if (typeof verdict === "string") {
        record(name, "fail", verdict, result.data);
      } else {
        record(
          name,
          verdict.status || "functional_defect",
          verdict.detail,
          result.data,
        );
      }
      return result;
    } catch (error) {
      record(
        name,
        "fail",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  };

  try {
    const health = await fetch(`${origin}/confucius/v1/health`).then(
      (response) => response.json(),
    );
    auxiliary.push({ check: "health", status: "pass", evidence: health });
    const pdfBytes = await readFile(PDF_FIXTURE);
    server = await startDeterministicServer(pdfBytes);
    originalConfig = await rpc("config/get");
    const configured = await rpc("config/set", {
      endpoint: {
        name: "Confucius deterministic E2E",
        baseUrl: MOCK_BASE_URL,
        apiKey: "local-e2e-only",
        model: "confucius-e2e",
        maxTokens: 0,
        reasoningEffort: "off",
        contextWindowTokens: 32_768,
      },
      streamResponses: false,
      memoryAutoExtract: false,
      maxIterations: 8,
      maxToolCalls: 8,
    });
    temporaryEndpointId = configured.activeEndpointId;
    const session = await rpc("session/new", {
      title: runId,
      mode: "agent",
    });
    sessionId = session.id;
    await rpc("session/setPermissions", {
      sessionId,
      permissionMode: "auto_allow",
    });

    const collectionName = `${runId} Collection`;
    const renamedCollectionName = `${runId} Verified Collection`;
    const titleA = `${runId} Paper Alpha`;
    const titleB = `${runId} Paper Beta`;
    const noteText = `${runId} final note marker NOTE-FINAL-7788`;
    const tag = `confucius-e2e-${runId.slice(-14).toLowerCase()}`;
    const savedSearchName = `${runId} Saved Search`;
    let collectionKey = "";
    let itemAKey = "";
    let itemBKey = "";
    let noteKey = "";
    let annotationKey = "";
    let memoryId = "";

    let outcome = await exercise("create_collection", {
      name: collectionName,
      libraryID: 1,
    });
    collectionKey = outcome?.ok ? String(outcome.data.key || "") : "";

    outcome = await exercise(
      "rename_collection",
      { libraryID: 1, key: collectionKey, name: renamedCollectionName },
      {
        validate: (data) =>
          data.name === renamedCollectionName || "name was not persisted",
      },
    );

    outcome = await exercise("create_item", {
      itemType: "journalArticle",
      title: titleA,
      libraryID: 1,
      extra: {
        date: "2026",
        DOI: "10.5555/confucius.e2e.alpha",
        abstractNote: `${runId} deterministic abstract`,
        url: "https://example.invalid/confucius-e2e-alpha",
      },
    });
    itemAKey = outcome?.ok ? String(outcome.data.key || "") : "";

    outcome = await exercise("create_item", {
      itemType: "conferencePaper",
      title: titleB,
      libraryID: 1,
      extra: { date: "2026", abstractNote: `${runId} related item` },
    });
    itemBKey = outcome?.ok ? String(outcome.data.key || "") : "";

    await exercise(
      "update_item_metadata",
      {
        libraryID: 1,
        key: itemAKey,
        fields: {
          title: titleA,
          abstractNote: `${runId} updated abstract META-UPDATED-6161`,
        },
      },
      {
        validate: (data) =>
          data.title === titleA || "metadata update returned the wrong item",
      },
    );
    await exercise(
      "batch_update_tags",
      {
        libraryID: 1,
        key: itemAKey,
        add: [tag, `${tag}-temporary`],
        remove: [`${tag}-temporary`],
      },
      {
        validate: (data) =>
          includesText(data.tags, tag) || "tag was not persisted",
      },
    );
    await exercise("add_to_collection", {
      libraryID: 1,
      key: itemAKey,
      collectionKey,
    });
    await exercise("remove_from_collection", {
      libraryID: 1,
      key: itemAKey,
      collectionKey,
    });
    await callAgentTool("add_to_collection", {
      libraryID: 1,
      key: itemAKey,
      collectionKey,
    });
    await exercise("add_to_collection", {
      libraryID: 1,
      key: itemBKey,
      collectionKey,
    });
    await exercise(
      "link_related_items",
      { libraryID: 1, key: itemAKey, relatedKey: itemBKey },
      {
        validate: (data) =>
          data.relatedKey === itemBKey || "related key mismatch",
      },
    );
    outcome = await exercise("create_saved_search", {
      name: savedSearchName,
      query: titleA,
      libraryID: 1,
    });
    const savedSearchKey = outcome?.ok ? String(outcome.data.key || "") : "";

    outcome = await exercise("create_note", {
      libraryID: 1,
      parentKey: itemAKey,
      content: `${runId} initial note NOTE-INITIAL-1010`,
    });
    noteKey = outcome?.ok ? String(outcome.data.key || "") : "";
    await exercise("append_to_note", {
      libraryID: 1,
      key: noteKey,
      content: `${runId} appended NOTE-APPEND-2020`,
    });
    await exercise("update_note", {
      libraryID: 1,
      key: noteKey,
      content: noteText,
    });
    const attachmentAttempts = [];
    for (const source of [
      { kind: "url", args: { url: `${MOCK_ORIGIN}/fixture.pdf` } },
      { kind: "path", args: { path: PDF_FIXTURE } },
    ]) {
      try {
        const result = await callAgentTool("attach_file", {
          libraryID: 1,
          key: itemAKey,
          ...source.args,
        });
        attachmentAttempts.push({ source: source.kind, result });
      } catch (error) {
        attachmentAttempts.push({
          source: source.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const attachmentFailures = attachmentAttempts.filter(
      (attempt) =>
        attempt.error ||
        !attempt.result?.ok ||
        attempt.result.toolName !== "attach_file" ||
        !attempt.result.data?.key ||
        attempt.result.data?.source !== attempt.source,
    );
    if (attachmentFailures.length) {
      record(
        "attach_file",
        "fail",
        "local-path or URL attachment regression failed",
        attachmentAttempts,
      );
    } else {
      record(
        "attach_file",
        "pass",
        "local path and HTTP URL both attached through the real AgentHost",
        attachmentAttempts,
      );
    }
    const pathAttachment = attachmentAttempts.find(
      (attempt) => attempt.source === "path" && attempt.result?.ok,
    );
    const urlAttachment = attachmentAttempts.find(
      (attempt) => attempt.source === "url" && attempt.result?.ok,
    );
    const attachmentKey = String(
      pathAttachment?.result?.data?.key ||
        urlAttachment?.result?.data?.key ||
        "",
    );

    let indexed = false;
    if (itemAKey) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const probe = await mcp("tools/call", {
          name: "get_page_count",
          arguments: { libraryID: 1, key: itemAKey },
        });
        if (!probe.isError) {
          indexed = true;
          break;
        }
        await delay(2_000);
      }
    }
    auxiliary.push({
      check: "pdf_index_ready",
      status: indexed ? "pass" : "environment_blocked",
      evidence: { itemAKey, attachmentKey },
    });

    let fulltextReady = false;
    if (indexed) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const probe = await mcp("tools/call", {
          name: "search_fulltext",
          arguments: {
            query: "ALPHA-VERIFY-2026",
            libraryID: 1,
            limit: 10,
          },
        });
        if (!probe.isError && includesText(probe.content, itemAKey)) {
          fulltextReady = true;
          break;
        }
        await delay(2_000);
      }
    }
    auxiliary.push({
      check: "fulltext_search_ready",
      status: fulltextReady ? "pass" : "functional_defect",
      evidence: { indexed, itemAKey },
    });

    const readCases = [
      [
        "search_items",
        { query: titleA, field: "title", libraryID: 1, limit: 10 },
        (data) =>
          includesText(data.items, itemAKey) || "created item was not found",
      ],
      [
        "search_fulltext",
        { query: "ALPHA-VERIFY-2026", libraryID: 1, limit: 10 },
        (data) =>
          !indexed
            ? {
                status: "environment_blocked",
                detail: "PDF index was not ready",
              }
            : fulltextReady && includesText(data.items, itemAKey)
              ? true
              : {
                  status: "functional_defect",
                  detail:
                    "paper text APIs worked, but library full-text search never found the indexed fixture",
                },
      ],
      [
        "search_notes",
        { query: "NOTE-FINAL-7788", libraryID: 1 },
        (data) =>
          includesText(data.items, noteKey) || "updated note was not found",
      ],
      [
        "search_by_tag",
        { tag, libraryID: 1 },
        (data) =>
          includesText(data.items, itemAKey) || "tagged item was not found",
      ],
      [
        "get_item",
        { libraryID: 1, key: itemAKey },
        (data) => data.title === titleA || "item title mismatch",
      ],
      [
        "get_item_metadata",
        { libraryID: 1, key: itemAKey },
        (data) =>
          includesText(data.abstract, "META-UPDATED-6161") ||
          "updated abstract was not returned",
      ],
      [
        "get_item_notes",
        { libraryID: 1, key: itemAKey },
        (data) =>
          includesText(data.notes, noteKey) || "child note was not returned",
      ],
      [
        "get_note_content",
        { libraryID: 1, key: noteKey },
        (data) =>
          includesText(data.html, "NOTE-FINAL-7788") ||
          "replacement note body was not returned",
      ],
      [
        "get_collections",
        { libraryID: 1 },
        (data) =>
          includesText(data.collections, renamedCollectionName) ||
          "renamed collection was not listed",
      ],
      [
        "get_collection_items",
        { libraryID: 1, key: collectionKey, limit: 20 },
        (data) =>
          (includesText(data.items, itemAKey) &&
            includesText(data.items, itemBKey)) ||
          "collection membership mismatch",
      ],
      [
        "get_tags",
        { libraryID: 1 },
        (data) => includesText(data.tags, tag) || "tag was not listed",
      ],
      [
        "get_recent",
        { libraryID: 1, limit: 50 },
        (data) =>
          includesText(data.items, itemAKey) || "created item was not recent",
        { defectCodes: ["internal"] },
      ],
      [
        "list_saved_searches",
        { libraryID: 1 },
        (data) =>
          includesText(data.searches, savedSearchKey) ||
          "saved search was not listed",
      ],
      [
        "run_saved_search",
        { libraryID: 1, key: savedSearchKey },
        (data) =>
          includesText(data.items, itemAKey)
            ? true
            : {
                status: "functional_defect",
                detail:
                  "saved search was created and listed but returned no fixture item",
              },
      ],
      [
        "get_related_items",
        { libraryID: 1, key: itemAKey },
        (data) =>
          includesText(data.items, itemBKey) || "related item was not returned",
      ],
    ];
    for (const [name, args, validate, options = {}] of readCases) {
      await exercise(name, args, { ...options, validate });
    }

    const paperArgs = { libraryID: 1, key: itemAKey };
    const indexVerdict = (check) => (data) =>
      !indexed
        ? { status: "environment_blocked", detail: "PDF index was not ready" }
        : check(data);
    await exercise("get_outline", paperArgs, {
      validate: indexVerdict(
        (data) =>
          includesText(data.sections, "methodology") ||
          "methodology section missing",
      ),
    });
    await exercise("list_sections", paperArgs, {
      validate: indexVerdict(
        (data) =>
          includesText(data.sections, "discussion") ||
          "discussion section missing",
      ),
    });
    await exercise(
      "get_paper_section",
      { ...paperArgs, section: "methodology" },
      {
        validate: indexVerdict(
          (data) =>
            includesText(data.content, "BETA-RECT-4242") ||
            "methodology body mismatch",
        ),
      },
    );
    await exercise(
      "get_pages",
      { ...paperArgs, start: 1, end: 3 },
      {
        validate: indexVerdict(
          (data) =>
            Number(data.pageCount) >= 3 || "page count/range was not preserved",
        ),
      },
    );
    await exercise("get_page_count", paperArgs, {
      validate: indexVerdict(
        (data) =>
          Number(data.pageCount) >= 3 || "expected at least three pages",
      ),
    });
    await exercise(
      "search_paper_content",
      { ...paperArgs, query: "GAMMA-FINAL-9000" },
      {
        validate: indexVerdict(
          (data) =>
            (data.hits || []).length > 0 || "literal paper search found no hit",
        ),
      },
    );
    await exercise(
      "search_with_regex",
      { ...paperArgs, pattern: "BETA-RECT-[0-9]+" },
      {
        validate: indexVerdict(
          (data) =>
            (data.hits || []).length > 0 || "regex paper search found no hit",
        ),
      },
    );
    await exercise("get_paper_metadata", paperArgs, {
      validate: (data) =>
        data.title === titleA || "paper metadata title mismatch",
    });
    await exercise("open_item", paperArgs, {
      validate: (data) => data.key === itemAKey || "opened the wrong item",
      okDetail: "tool opened the fixture in the real Zotero reader",
    });
    await exercise("get_pdf_selection", paperArgs, {
      validate: (data) =>
        typeof data.text === "string" ||
        "selection response did not contain text",
      okDetail:
        "transport returned current selection state; non-empty selection requires Computer Use",
    });

    await exercise(
      "propose_highlights",
      {
        ...paperArgs,
        highlights: [
          {
            text: "BETA-RECT-4242",
            page: 2,
            comment: `${runId} proposed highlight`,
          },
        ],
      },
      {
        validate: (data) =>
          (data.count === 1 && data.persisted === false) ||
          "proposal state mismatch",
      },
    );
    outcome = await exercise("commit_annotations", paperArgs, {
      validate: (data) =>
        (data.mode === "annotations" &&
          data.count === 1 &&
          Array.isArray(data.keys) &&
          data.keys.length === 1) ||
        "real Zotero annotation was not committed",
    });
    annotationKey = outcome?.ok
      ? String(outcome.data.keys?.[0] || outcome.data.key || "")
      : "";
    await exercise("get_annotations", paperArgs, {
      validate: (data) =>
        (Array.isArray(data.annotations) &&
          data.annotations.some(
            (annotation) =>
              annotation.key === annotationKey &&
              annotation.type === "highlight" &&
              includesText(annotation.text, "BETA-RECT-4242") &&
              Array.isArray(annotation.position?.rects) &&
              annotation.position.rects.length > 0,
          )) ||
        "committed PDF highlight was not returned with a real position",
      okDetail:
        "read path returned the real Zotero PDF highlight and coordinates",
      defectCodes: ["internal"],
    });
    const updatedComment = `${runId} updated annotation comment`;
    await exercise(
      "update_annotation_comment",
      {
        libraryID: 1,
        key: annotationKey,
        comment: updatedComment,
      },
      {
        validate: (data) =>
          (data.key === annotationKey && data.comment === updatedComment) ||
          "real annotation comment was not updated",
      },
    );
    const updatedProbe = await callAgentTool("get_annotations", paperArgs);
    if (
      !updatedProbe.ok ||
      !updatedProbe.data.annotations?.some(
        (annotation) =>
          annotation.key === annotationKey &&
          annotation.comment === updatedComment,
      )
    ) {
      record(
        "update_annotation_comment",
        "functional_defect",
        "updated comment was not persisted on the PDF annotation",
        updatedProbe,
      );
    }
    await exercise(
      "delete_annotation",
      {
        libraryID: 1,
        key: annotationKey,
      },
      {
        validate: (data) =>
          data.key === annotationKey || "deleted the wrong annotation",
      },
    );
    const deletedProbe = await callAgentTool("get_annotations", paperArgs);
    if (
      !deletedProbe.ok ||
      deletedProbe.data.annotations?.some(
        (annotation) => annotation.key === annotationKey,
      )
    ) {
      record(
        "delete_annotation",
        "functional_defect",
        "annotation remained after delete",
        deletedProbe,
      );
    }

    const updateNoteRejection = await callAgentTool(
      "update_annotation_comment",
      {
        libraryID: 1,
        key: noteKey,
        comment: `${runId} must not replace a note`,
      },
    );
    if (updateNoteRejection.ok || updateNoteRejection.code !== "invalid_args") {
      record(
        "update_annotation_comment",
        "functional_defect",
        "non-annotation note was not rejected",
        updateNoteRejection,
      );
    }
    const deleteNoteRejection = await callAgentTool("delete_annotation", {
      libraryID: 1,
      key: noteKey,
    });
    if (deleteNoteRejection.ok || deleteNoteRejection.code !== "invalid_args") {
      record(
        "delete_annotation",
        "functional_defect",
        "non-annotation note was not rejected",
        deleteNoteRejection,
      );
    }

    outcome = await exercise(
      "memory_save",
      {
        content: `${runId} memory content MEMORY-ORIGINAL-5656`,
        type: "fact",
        title: `${runId} Memory`,
        tags: ["confucius-e2e"],
      },
      { defectCodes: ["not_found", "internal"] },
    );
    memoryId = outcome?.ok ? String(outcome.data.id || "") : "";
    await exercise(
      "memory_search",
      { query: "MEMORY-ORIGINAL-5656", limit: 10 },
      {
        validate: (data) =>
          includesText(data.results, memoryId) ||
          "saved memory was not searchable",
        defectCodes: ["not_found", "internal"],
      },
    );
    await exercise(
      "memory_list",
      { type: "fact", limit: 50 },
      {
        validate: (data) =>
          includesText(data.memories, memoryId) ||
          "saved memory was not listed",
        defectCodes: ["not_found", "internal"],
      },
    );
    await exercise(
      "memory_update",
      {
        id: memoryId,
        title: `${runId} Updated Memory`,
        content: `${runId} memory content MEMORY-UPDATED-6767`,
      },
      {
        validate: (data) => data.id === memoryId || "updated the wrong memory",
        defectCodes: ["not_found", "internal"],
      },
    );
    await exercise(
      "conversation_log_search",
      { query: runId, limit: 10 },
      {
        validate: (data) =>
          (Array.isArray(data.results) &&
            data.results.some((hit) =>
              includesText([hit.excerpt, hit.sessionId, hit.title], runId),
            )) ||
          "conversation log search did not recover this run",
        defectCodes: ["not_found", "internal", "unavailable"],
      },
    );
    const logHits = await rpc("logs/search", { query: runId, limit: 5 }).catch(
      () => ({ results: [] }),
    );
    const logSessionId = logHits.results?.[0]?.sessionId || "";
    await exercise(
      "conversation_log_read",
      logSessionId
        ? { sessionId: logSessionId, query: runId, maxChars: 4000 }
        : { sessionId: "ses_missing", maxChars: 400 },
      {
        validate: logSessionId
          ? (data) =>
              includesText(
                [data.log?.content, data.log?.excerpt, data.log?.sessionId],
                runId,
              ) || "conversation log read did not return this run"
          : undefined,
        defectCodes: logSessionId
          ? ["internal", "unavailable"]
          : ["not_found", "internal", "unavailable"],
      },
    );
    await exercise(
      "memory_delete",
      { id: memoryId },
      { defectCodes: ["not_found", "internal"] },
    );
    if (memoryId) {
      try {
        const deletedMemoryProbe = await rpc("memory/search", {
          query: "MEMORY-UPDATED-6767",
          limit: 20,
        });
        auxiliary.push({
          check: "memory_delete_persisted",
          status: includesText(deletedMemoryProbe.results, memoryId)
            ? "fail"
            : "pass",
          evidence: compactEvidence(deletedMemoryProbe),
        });
      } catch (error) {
        auxiliary.push({
          check: "memory_delete_persisted",
          status: "functional_defect",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      auxiliary.push({
        check: "memory_delete_persisted",
        status: "functional_defect",
        error:
          "memory_save never produced an id because memory tools were misrouted",
      });
    }

    outcome = await exercise(
      "knowledge_base_create",
      {
        title: `${runId} Research Topic`,
        description: `${runId} durable topic for knowledge-base verification`,
        tags: ["confucius-e2e", "research-assistant"],
      },
      {
        validate: (data) =>
          Boolean(data.knowledgeBase?.id) ||
          "knowledge base id was not returned",
      },
    );
    temporaryKnowledgeBaseId = outcome?.ok
      ? String(outcome.data.knowledgeBase?.id || "")
      : "";
    outcome = await exercise(
      "knowledge_base_save_entry",
      {
        knowledgeBaseId: temporaryKnowledgeBaseId,
        kind: "mindmap",
        title: `${runId} Mind Map`,
        content: `# ${runId} Topic\n- Evidence\n  - KB-MINDMAP-7788\n- Open questions`,
        tags: ["confucius-e2e", "outline"],
      },
      {
        validate: (data) =>
          (data.entry?.id && data.entry?.kind === "mindmap") ||
          "mind-map entry was not persisted",
      },
    );
    const knowledgeEntryId = outcome?.ok
      ? String(outcome.data.entry?.id || "")
      : "";
    await exercise(
      "knowledge_base_list",
      { query: `${runId} Research Topic`, limit: 20 },
      {
        validate: (data) =>
          includesText(data.knowledgeBases, temporaryKnowledgeBaseId) ||
          "created knowledge base was not listed",
      },
    );
    await exercise(
      "knowledge_base_get",
      { id: temporaryKnowledgeBaseId, limit: 20 },
      {
        validate: (data) =>
          (includesText(data.knowledgeBase, knowledgeEntryId) &&
            includesText(data.knowledgeBase, "KB-MINDMAP-7788")) ||
          "knowledge-base detail omitted its mind map",
      },
    );
    await exercise(
      "knowledge_base_search",
      {
        query: "KB-MINDMAP-7788",
        knowledgeBaseId: temporaryKnowledgeBaseId,
        kind: "mindmap",
        limit: 20,
      },
      {
        validate: (data) =>
          includesText(data.results, knowledgeEntryId) ||
          "knowledge-base search did not return the saved mind map",
      },
    );
    const migratedEntry = await callAgentTool("knowledge_base_save_entry", {
      id: knowledgeEntryId,
      knowledgeBaseId: temporaryKnowledgeBaseId,
      kind: "insight",
      title: `${runId} Migrated Insight`,
      content: `${runId} KB-KIND-MIGRATION-9900`,
      tags: ["confucius-e2e", "migrated"],
    });
    const migratedSearch = await callAgentTool("knowledge_base_search", {
      query: "KB-KIND-MIGRATION-9900",
      knowledgeBaseId: temporaryKnowledgeBaseId,
      kind: "insight",
      limit: 20,
    });
    if (
      !migratedEntry.ok ||
      migratedEntry.data.entry?.kind !== "insight" ||
      !migratedSearch.ok ||
      !includesText(migratedSearch.data.results, knowledgeEntryId)
    ) {
      record(
        "knowledge_base_save_entry",
        "functional_defect",
        "changing an existing entry kind did not update typed retrieval",
        { migratedEntry, migratedSearch },
      );
    }
    await exercise(
      "knowledge_base_update",
      {
        id: temporaryKnowledgeBaseId,
        description: `${runId} updated topic scope KB-SCOPE-8899`,
        tags: ["confucius-e2e", "updated"],
      },
      {
        validate: (data) =>
          includesText(data.knowledgeBase, "KB-SCOPE-8899") ||
          "knowledge-base scope was not updated",
      },
    );

    await exercise(
      "add_item",
      {
        identifier: "10.1038/nphys1170",
        libraryID: 1,
        collectionKey,
      },
      {
        validate: (data) =>
          (data.items || []).length > 0 || "identifier lookup returned no item",
        blockedCodes: ["unavailable", "timeout", "internal", "not_found"],
        timeoutMs: 180_000,
      },
    );

    const listed = await mcp("tools/list");
    const listedNames = (listed.tools || []).map((tool) => tool.name).sort();
    const expectedNames = [...READ_ONLY_TOOLS].sort();
    auxiliary.push({
      check: "mcp_read_only_catalog",
      status:
        JSON.stringify(listedNames) === JSON.stringify(expectedNames)
          ? "pass"
          : "fail",
      evidence: { expectedCount: expectedNames.length, listedNames },
    });
    for (const name of READ_ONLY_TOOLS) {
      const args = exercisedArgs.get(name) || {};
      try {
        const result = await mcp("tools/call", { name, arguments: args });
        const audit = {
          tool: name,
          status: result.isError ? "fail" : "pass",
          evidence: compactEvidence(result),
        };
        mcpAudit.push(audit);
        if (result.isError && matrix.get(name)?.status === "pass") {
          const current = matrix.get(name);
          record(
            name,
            "functional_defect",
            `${current.detail}; advertised MCP call failed`,
            { agent: current.evidence, mcp: result },
          );
        }
      } catch (error) {
        mcpAudit.push({
          tool: name,
          status: "fail",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const counts = Object.fromEntries(
      [
        "pass",
        "functional_defect",
        "environment_blocked",
        "fail",
        "not_tested",
      ].map((status) => [
        status,
        [...matrix.values()].filter((entry) => entry.status === status).length,
      ]),
    );
    const report = {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      zoteroOrigin: origin,
      fixture: {
        collectionKey,
        collectionName: renamedCollectionName,
        itemAKey,
        itemATitle: titleA,
        itemBKey,
        itemBTitle: titleB,
        noteKey,
        attachmentKey,
        savedSearchKey,
        savedSearchName,
        knowledgeBaseId: temporaryKnowledgeBaseId,
      },
      counts,
      matrix: [...matrix.values()],
      auxiliary,
      mcpAudit,
      computerUse: {
        status: "not_part_of_script",
        note: "Run separately with the Computer Use skill against the real windows.",
      },
    };
    await mkdir(dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nReport: ${REPORT_PATH}`);
    console.log(`Counts: ${JSON.stringify(counts)}`);
    if (
      counts.fail > 0 ||
      counts.functional_defect > 0 ||
      counts.not_tested > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    if (temporaryKnowledgeBaseId) {
      await rpc("knowledge/delete", {
        id: temporaryKnowledgeBaseId,
      }).catch(() => undefined);
    }
    if (sessionId) {
      await rpc("session/delete", { sessionId }).catch(() => undefined);
    }
    if (originalConfig && temporaryEndpointId) {
      await rpc("config/set", {
        activeEndpointId: originalConfig.activeEndpointId,
        streamResponses: originalConfig.streamResponses,
        memoryAutoExtract: originalConfig.memoryAutoExtract,
        maxIterations: originalConfig.maxIterations,
        maxToolCalls: originalConfig.maxToolCalls,
      }).catch(() => undefined);
      await rpc("config/set", {
        deleteEndpointId: temporaryEndpointId,
      }).catch(() => undefined);
    }
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
