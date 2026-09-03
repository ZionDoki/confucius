#!/usr/bin/env node
import { createInterface } from "node:readline";

const url = process.env.CONFUCIUS_MCP_URL;
const token =
  process.env.CONFUCIUS_MCP_TOKEN || process.env.CONFUCIUS_PAIRING_TOKEN;
if (!url || !token) {
  process.stderr.write(
    "CONFUCIUS_MCP_URL and CONFUCIUS_MCP_TOKEN (or CONFUCIUS_PAIRING_TOKEN) are required\n",
  );
  process.exitCode = 2;
} else {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as { id?: unknown; method?: string };
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: line,
      });
      const text = await response.text();
      if (message.id !== undefined && text.trim())
        process.stdout.write(`${text.trim()}\n`);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
