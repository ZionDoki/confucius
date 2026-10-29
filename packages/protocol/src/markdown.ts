/** Escape text that will sit in HTML or attributes. */
export function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Transform visible citation markers while leaving code, math and links intact. */
export function mapMarkdownCitations(
  source: string,
  replace: (id: string, marker: string) => string,
): string {
  let fenced = false;
  let displayEnd = -1;
  const lines = source.split("\n");
  return lines
    .map((line, index) => {
      if (index <= displayEnd) return line;
      if (line.trim().startsWith("```")) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      displayEnd = displayMathEnd(lines, index);
      if (displayEnd > index) return line;
      return mapLineCitations(line, replace);
    })
    .join("\n");
}

const STICKY_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/y;
const STICKY_CITATION = /\[cite:([a-zA-Z0-9_-]{1,80})\]/y;

/**
 * Replace citations in one visible line. The protected constructs mirror the
 * renderer, and math uses the same `inlineMathClose` rule, so a price range
 * cannot swallow a citation here while staying prose in `renderMarkdownHtml`.
 */
function mapLineCitations(
  line: string,
  replace: (id: string, marker: string) => string,
): string {
  let out = "";
  let index = 0;
  let mathDisabled = false;
  while (index < line.length) {
    const char = line[index];
    if (char === "`") {
      const close = line.indexOf("`", index + 1);
      if (close > index) {
        out += line.slice(index, close + 1);
        index = close + 1;
        continue;
      }
    }
    if (!mathDisabled && char === "$") {
      if (line.startsWith("$$", index)) {
        const close = line.indexOf("$$", index + 2);
        if (close >= 0) {
          out += line.slice(index, close + 2);
          index = close + 2;
          continue;
        }
        // An unmatched display opener stops math extraction for the rest of
        // the line; visible citations after it still need mapping.
        mathDisabled = true;
      } else {
        const close = inlineMathClose(line, index);
        if (close >= 0) {
          out += line.slice(index, close + 1);
          index = close + 1;
          continue;
        }
      }
    }
    if (char === "[") {
      STICKY_LINK.lastIndex = index;
      const link = STICKY_LINK.exec(line);
      if (link && link.index === index) {
        out += link[0];
        index += link[0].length;
        continue;
      }
      STICKY_CITATION.lastIndex = index;
      const citation = STICKY_CITATION.exec(line);
      if (citation && citation.index === index) {
        out += replace(citation[1], citation[0]);
        index += citation[0].length;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:|zotero:|#)/i.test(href.trim());
}

type MathSlot = { tex: string; display: boolean };

/**
 * Internal math slots use a delimiter that cannot come from authored Markdown,
 * so a literal `%%MATH0%%` in prose can never be consumed as a formula.
 */
const MATH_TOKEN_OPEN = "\u0000\u0001";
const MATH_TOKEN_CLOSE = "\u0001\u0000";

function mathToken(index: number): string {
  return `${MATH_TOKEN_OPEN}${index}${MATH_TOKEN_CLOSE}`;
}

function displayMathEnd(lines: string[], start: number): number {
  if (lines[start].trim() !== "$$") return -1;
  for (let end = start + 1; end < lines.length; end++) {
    if (lines[end].trim().startsWith("```")) return -1;
    if (lines[end].trim() === "$$") return end;
  }
  return -1;
}

function extractMath(source: string): { text: string; slots: MathSlot[] } {
  const slots: MathSlot[] = [];
  const parts: string[] = [];
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
    // Display formulas commonly put the delimiters on their own lines. Keep
    // their newlines inside one math slot so block parsing cannot split TeX.
    const displayEnd = displayMathEnd(lines, lineIndex);
    if (displayEnd > lineIndex) {
      parts.push(mathToken(slots.length));
      slots.push({
        tex: lines.slice(lineIndex + 1, displayEnd).join("\n"),
        display: true,
      });
      lineIndex = displayEnd;
      if (lineIndex < lines.length - 1) parts.push("\n");
      continue;
    }
    let rest = line;
    let built = "";
    while (rest.length) {
      const display = rest.indexOf("$$");
      const inline = findInlineDollar(rest);
      let next = -1;
      let kind: "display" | "inline" | null = null;
      if (display >= 0 && (inline < 0 || display <= inline)) {
        next = display;
        kind = "display";
      } else if (inline >= 0) {
        next = inline;
        kind = "inline";
      }
      const codeStart = rest.indexOf("`");
      if (codeStart >= 0 && (next < 0 || codeStart < next)) {
        const codeEnd = rest.indexOf("`", codeStart + 1);
        if (codeEnd >= 0) {
          built += rest.slice(0, codeEnd + 1);
          rest = rest.slice(codeEnd + 1);
          continue;
        }
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
        const token = mathToken(slots.length);
        slots.push({ tex, display: true });
        built += token;
        rest = rest.slice(close + 2);
      } else {
        const close = inlineMathClose(rest, 0);
        if (close < 0) {
          built += rest;
          rest = "";
          break;
        }
        const tex = rest.slice(1, close);
        const token = mathToken(slots.length);
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

function findInlineDollar(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "$") {
      continue;
    }
    if (inlineMathClose(text, index) >= 0) {
      return index;
    }
  }
  return -1;
}

/**
 * Currency text such as `$5 per call ... and $10` must stay prose. Inline math
 * cannot open or close on whitespace and cannot cross another `$`, so the first
 * invalid candidate abandons the opener instead of swallowing later text.
 */
function inlineMathClose(text: string, open: number): number {
  if (open > 0 && text[open - 1] === "\\") return -1;
  const first = text[open + 1];
  if (!first || first === "$" || /\s/.test(first)) return -1;
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] !== "$") {
      continue;
    }
    if (text[index - 1] === "\\") {
      continue;
    }
    const tex = text.slice(open + 1, index);
    if (!tex || /\s$/.test(tex)) return -1;
    // A price range such as "$5-$10" or "$5 [cite:e1]-$10" would
    // otherwise swallow the prose and its citation between the amounts.
    // Plain amounts such as `$1.2$` or `Base-$10$` stay formulas.
    const after = text[index + 1];
    if (/\d/.test(first) && after !== undefined && /\d/.test(after)) return -1;
    return index;
  }
  return -1;
}

function renderInline(source: string, slots: MathSlot[]): string {
  let html = "";
  let rest = source;
  while (rest.length) {
    const math = rest.match(/^\u0000\u0001(\d+)\u0001\u0000/);
    if (math) {
      const slot = slots[Number(math[1])];
      if (slot) {
        const display = slot.display ? "1" : "0";
        html += `<span class="tui-math" data-display="${display}" data-tex="${escapeHtml(slot.tex)}">${escapeHtml(slot.tex)}</span>`;
      } else {
        // A missing slot is internal corruption; keep a visible marker instead
        // of silently deleting the surrounding text.
        html += escapeHtml(`%%MATH${math[1]}%%`);
      }
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
      const href = escapeHtml(link[2]);
      // Labels are plain text: expand math slots back to source so an internal
      // token cannot leak into the HTML.
      const label = escapeHtml(plainMathText(link[1], slots));
      // data-href survives chrome innerHTML even if href with a custom
      // scheme is dropped; the workspace hydrates real <a href> from it.
      html += `<a href="${href}" data-href="${href}" rel="noreferrer">${label}</a>`;
      rest = rest.slice(link[0].length);
      continue;
    }
    const citation = rest.match(/^\[cite:([a-zA-Z0-9_-]{1,80})\]/);
    if (citation) {
      html += `<span class="confucius-citation-reference" data-citation-id="${citation[1]}">${citation[0]}</span>`;
      rest = rest.slice(citation[0].length);
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

/**
 * Sinks rendered as plain text (for example a details title) still need the
 * original math source instead of leaking an internal slot token.
 */
function plainMathText(source: string, slots: MathSlot[]): string {
  return source.replace(
    /\u0000\u0001(\d+)\u0001\u0000/g,
    (_match, index: string) => {
      const slot = slots[Number(index)];
      if (!slot) return "";
      return slot.display ? `$$${slot.tex}$$` : `$${slot.tex}$`;
    },
  );
}

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|")) {
    row = row.slice(0, -1);
  }
  return row.split("|").map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
  );
}

function renderTable(lines: string[], slots: MathSlot[]): string {
  const header = splitTableRow(lines[0]);
  const body = lines.slice(2);
  const head = header
    .map((cell) => `<th>${renderInline(cell, slots)}</th>`)
    .join("");
  const rows = body
    .map((line) => {
      const cells = splitTableRow(line);
      return `<tr>${cells
        .map((cell) => `<td>${renderInline(cell, slots)}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderList(
  lines: string[],
  ordered: boolean,
  slots: MathSlot[],
): string {
  const tag = ordered ? "ol" : "ul";
  const items = lines
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))
    .map((item) => `<li>${renderInline(item, slots)}</li>`)
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

/**
 * Convert Markdown (GFM tables, fences, emphasis, links, $math$) into HTML.
 * Math is emitted as .tui-math placeholders for KaTeX/MathML later.
 */
export function renderMarkdownHtml(
  source: string,
  options: { expandReadingBlocks?: boolean } = {},
): string {
  const { text, slots } = extractMath(source.replace(/\r\n/g, "\n"));
  return renderBlocks(text.split("\n"), slots, options, true);
}

function renderBlocks(
  lines: string[],
  slots: MathSlot[],
  options: { expandReadingBlocks?: boolean },
  allowReadingBlocks: boolean,
): string {
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const lang = escapeHtml(line.trim().slice(3).trim());
      const body: string[] = [];
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
      const table: string[] = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        table.push(lines[index]);
        index += 1;
      }
      blocks.push(renderTable(table, slots));
      continue;
    }
    // A small closed grammar, not raw HTML. Invalid/unclosed blocks remain text.
    const readingBlock = allowReadingBlocks
      ? line.match(/^:::(parallel|details(?:\s+(.+)))\s*$/)
      : null;
    if (readingBlock) {
      let end = index + 1;
      let fenced = false;
      let nested = false;
      for (; end < lines.length; end++) {
        if (lines[end].trim().startsWith("```")) fenced = !fenced;
        if (fenced) continue;
        if (lines[end].trim() === ":::") break;
        if (/^:::(parallel|details)\b/.test(lines[end])) nested = true;
      }
      if (end < lines.length && !nested) {
        const body = lines.slice(index + 1, end);
        const render = (content: string[]) =>
          renderBlocks(content, slots, options, false);
        if (readingBlock[2]) {
          const title = escapeHtml(
            plainMathText(readingBlock[2].trim(), slots),
          );
          blocks.push(
            options.expandReadingBlocks
              ? `<div><p><strong>${title}</strong></p>${render(body)}</div>`
              : `<details class="confucius-reading-help"><summary>${title}</summary>${render(body)}</details>`,
          );
          index = end + 1;
          continue;
        }
        while (body.length && !body[0].trim()) body.shift();
        const quote: string[] = [];
        while (body.length && /^\s*>\s?/.test(body[0]))
          quote.push(body.shift()!);
        if (quote.length && body.some((part) => part.trim())) {
          const source = render(quote),
            explanation = render(body);
          blocks.push(
            options.expandReadingBlocks
              ? `${source}${explanation}`
              : `<div class="confucius-reading-parallel"><div>${source}</div><div>${explanation}</div></div>`,
          );
          index = end + 1;
          continue;
        }
      }
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2], slots)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      blocks.push("<hr/>");
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
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
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index]);
        index += 1;
      }
      blocks.push(renderList(items, false, slots));
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index]);
        index += 1;
      }
      blocks.push(renderList(items, true, slots));
      continue;
    }
    const para: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !lines[index].trim().startsWith("|") &&
      !/^:::(parallel|details)\b/.test(lines[index]) &&
      !/^#{1,6}\s+/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index])
    ) {
      para.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${renderInline(para.join(" "), slots)}</p>`);
  }
  return blocks.join("");
}
