"use strict";
var ConfuciusMarkdown = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if ((from && typeof from === "object") || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, {
            get: () => from[key],
            enumerable:
              !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
          });
    }
    return to;
  };
  var __toCommonJS = (mod) =>
    __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/protocol/src/markdown.ts
  var markdown_exports = {};
  __export(markdown_exports, {
    escapeHtml: () => escapeHtml,
    renderMarkdownHtml: () => renderMarkdownHtml,
  });
  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function isSafeHref(href) {
    return /^(https?:|mailto:|#)/i.test(href.trim());
  }
  function extractMath(source) {
    const slots = [];
    const parts = [];
    let inFence = false;
    const lines = source.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const fence = line.trim().startsWith("```");
      if (fence) {
        inFence = !inFence;
        parts.push(line);
        if (lineIndex < lines.length - 1) {
          parts.push("\n");
        }
        continue;
      }
      if (inFence) {
        parts.push(line);
        if (lineIndex < lines.length - 1) {
          parts.push("\n");
        }
        continue;
      }
      let rest = line;
      let built = "";
      while (rest.length) {
        const display = rest.indexOf("$$");
        const inline = findInlineDollar(rest);
        let next = -1;
        let kind = null;
        if (display >= 0 && (inline < 0 || display <= inline)) {
          next = display;
          kind = "display";
        } else if (inline >= 0) {
          next = inline;
          kind = "inline";
        }
        if (next < 0 || !kind) {
          built += rest;
          break;
        }
        built += rest.slice(0, next);
        rest = rest.slice(next);
        if (kind === "display") {
          const close = rest.indexOf("$$", 2);
          if (close < 0) {
            built += rest;
            rest = "";
            break;
          }
          const tex = rest.slice(2, close);
          const token = `%%MATH${slots.length}%%`;
          slots.push({ tex, display: true });
          built += token;
          rest = rest.slice(close + 2);
        } else {
          const close = rest.indexOf("$", 1);
          if (close < 0) {
            built += rest;
            rest = "";
            break;
          }
          const tex = rest.slice(1, close);
          const token = `%%MATH${slots.length}%%`;
          slots.push({ tex, display: false });
          built += token;
          rest = rest.slice(close + 1);
        }
      }
      parts.push(built);
      if (lineIndex < lines.length - 1) {
        parts.push("\n");
      }
    }
    return { text: parts.join(""), slots };
  }
  function findInlineDollar(text) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "$") {
        continue;
      }
      if (text[index + 1] === "$") {
        continue;
      }
      if (index > 0 && text[index - 1] === "\\") {
        continue;
      }
      return index;
    }
    return -1;
  }
  function renderInline(source, slots) {
    const restored = source.replace(/%%MATH(\d+)%%/g, (_match, raw) => {
      const slot = slots[Number(raw)];
      if (!slot) {
        return "";
      }
      const display = slot.display ? "1" : "0";
      return `<span class="tui-math" data-display="${display}" data-tex="${escapeHtml(slot.tex)}">${escapeHtml(slot.tex)}</span>`;
    });
    let html = "";
    let rest = restored;
    while (rest.length) {
      const math = rest.match(/^<span class="tui-math"[\s\S]*?<\/span>/);
      if (math) {
        html += math[0];
        rest = rest.slice(math[0].length);
        continue;
      }
      if (rest.startsWith("`")) {
        const close = rest.indexOf("`", 1);
        if (close > 0) {
          html += `<code>${escapeHtml(rest.slice(1, close))}</code>`;
          rest = rest.slice(close + 1);
          continue;
        }
      }
      const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
      if (link && isSafeHref(link[2])) {
        html += `<a href="${escapeHtml(link[2])}" rel="noreferrer">${escapeHtml(link[1])}</a>`;
        rest = rest.slice(link[0].length);
        continue;
      }
      if (rest.startsWith("**") || rest.startsWith("__")) {
        const mark = rest.slice(0, 2);
        const close = rest.indexOf(mark, 2);
        if (close > 2) {
          html += `<strong>${renderInline(rest.slice(2, close), slots)}</strong>`;
          rest = rest.slice(close + 2);
          continue;
        }
      }
      if (rest.startsWith("*") || rest.startsWith("_")) {
        const mark = rest[0];
        const close = rest.indexOf(mark, 1);
        if (close > 1) {
          html += `<em>${renderInline(rest.slice(1, close), slots)}</em>`;
          rest = rest.slice(close + 1);
          continue;
        }
      }
      html += escapeHtml(rest[0]);
      rest = rest.slice(1);
    }
    return html;
  }
  function splitTableRow(line) {
    let row = line.trim();
    if (row.startsWith("|")) {
      row = row.slice(1);
    }
    if (row.endsWith("|")) {
      row = row.slice(0, -1);
    }
    return row.split("|").map((cell) => cell.trim());
  }
  function isTableDivider(line) {
    const cells = splitTableRow(line);
    return (
      cells.length > 0 &&
      cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
    );
  }
  function renderTable(lines, slots) {
    const header = splitTableRow(lines[0]);
    const body = lines.slice(2);
    const head = header
      .map((cell) => `<th>${renderInline(cell, slots)}</th>`)
      .join("");
    const rows = body
      .map((line) => {
        const cells = splitTableRow(line);
        return `<tr>${cells.map((cell) => `<td>${renderInline(cell, slots)}</td>`).join("")}</tr>`;
      })
      .join("");
    return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }
  function renderList(lines, ordered, slots) {
    const tag = ordered ? "ol" : "ul";
    const items = lines
      .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""))
      .map((item) => `<li>${renderInline(item, slots)}</li>`)
      .join("");
    return `<${tag}>${items}</${tag}>`;
  }
  function renderMarkdownHtml(source) {
    const { text, slots } = extractMath(source.replace(/\r\n/g, "\n"));
    const lines = text.split("\n");
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }
      if (line.trim().startsWith("```")) {
        const lang = escapeHtml(line.trim().slice(3).trim());
        const body = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith("```")) {
          body.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          index += 1;
        }
        blocks.push(
          `<pre${lang ? ` data-lang="${lang}"` : ""}><code>${escapeHtml(body.join("\n"))}</code></pre>`,
        );
        continue;
      }
      if (
        line.trim().startsWith("|") &&
        index + 1 < lines.length &&
        isTableDivider(lines[index + 1])
      ) {
        const table = [line, lines[index + 1]];
        index += 2;
        while (index < lines.length && lines[index].trim().startsWith("|")) {
          table.push(lines[index]);
          index += 1;
        }
        blocks.push(renderTable(table, slots));
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        blocks.push(
          `<h${level}>${renderInline(heading[2], slots)}</h${level}>`,
        );
        index += 1;
        continue;
      }
      if (/^\s*[-*_]{3,}\s*$/.test(line)) {
        blocks.push("<hr/>");
        index += 1;
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        blocks.push(
          `<blockquote>${renderInline(quote.join(" "), slots)}</blockquote>`,
        );
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
          items.push(lines[index]);
          index += 1;
        }
        blocks.push(renderList(items, false, slots));
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
          items.push(lines[index]);
          index += 1;
        }
        blocks.push(renderList(items, true, slots));
        continue;
      }
      const para = [line];
      index += 1;
      while (
        index < lines.length &&
        lines[index].trim() &&
        !lines[index].trim().startsWith("```") &&
        !lines[index].trim().startsWith("|") &&
        !/^#{1,3}\s+/.test(lines[index]) &&
        !/^\s*[-*+]\s+/.test(lines[index]) &&
        !/^\s*\d+\.\s+/.test(lines[index])
      ) {
        para.push(lines[index]);
        index += 1;
      }
      blocks.push(`<p>${renderInline(para.join(" "), slots)}</p>`);
    }
    return blocks.join("");
  }
  return __toCommonJS(markdown_exports);
})();
