import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ATTACHMENT_CHARACTERS,
  TaskAttachmentStore,
  buildTaskAttachmentUserText,
  type TaskAttachmentIO,
} from "./TaskAttachments";

function fixtureIO(
  files: Record<string, Uint8Array>,
  pdfText = "Extracted PDF text",
): TaskAttachmentIO {
  let id = 0;
  return {
    normalizePath: (path) => path.replaceAll("/", "\\"),
    isAbsolutePath: (path) => /^[A-Z]:\\/i.test(path),
    filename: (path) => path.split("\\").at(-1) ?? "",
    stat: async (path) =>
      path in files
        ? { type: "regular", size: files[path].byteLength }
        : { type: "other", size: 0 },
    read: async (path) => files[path],
    decodeUtf8: (bytes) =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    extractPdf: async () => ({
      text: pdfText,
      extractedPages: 2,
      totalPages: 2,
    }),
    now: () => 1_000,
    createId: () => `att_${++id}`,
  };
}

describe("TaskAttachmentStore", () => {
  it("prepares UTF-8 Markdown without exposing its local path", async () => {
    const path = "C:\\Research\\notes.md";
    const files = { [path]: new TextEncoder().encode("# Notes\r\nEvidence") };
    const store = new TaskAttachmentStore(fixtureIO(files));
    const record = await store.prepare(path);
    assert.equal(record.name, "notes.md");
    assert.equal(record.kind, "markdown");
    assert.equal(record.mediaType, "text/markdown");
    assert.equal("sourcePath" in record, false);

    const prompt = buildTaskAttachmentUserText("Compare the claims", [
      ...store.resolve([record.id]),
    ]);
    assert.match(prompt, /Compare the claims/);
    assert.match(prompt, /# Notes\nEvidence/);
    assert.equal(prompt.includes("C:\\Research"), false);
  });

  it("checks the PDF signature and reports page extraction metadata", async () => {
    const path = "C:\\Research\\paper.pdf";
    const files = {
      [path]: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
    };
    const store = new TaskAttachmentStore(fixtureIO(files));
    const record = await store.prepare(path);
    assert.equal(record.kind, "pdf");
    assert.equal(record.extractedPages, 2);
    assert.equal(record.totalPages, 2);

    const invalidPath = "C:\\Research\\fake.pdf";
    const invalidStore = new TaskAttachmentStore(
      fixtureIO({ [invalidPath]: new TextEncoder().encode("not a pdf") }),
    );
    await assert.rejects(
      invalidStore.prepare(invalidPath),
      /does not contain a PDF header/,
    );
  });

  it("rejects unsupported or binary files and truncates large extracted text", async () => {
    const unsupported = "C:\\Research\\notes.docx";
    const binary = "C:\\Research\\notes.txt";
    const files = {
      [unsupported]: new Uint8Array([1]),
      [binary]: new Uint8Array([65, 0, 66]),
    };
    const store = new TaskAttachmentStore(fixtureIO(files));
    await assert.rejects(store.prepare(unsupported), /Only PDF/);
    await assert.rejects(store.prepare(binary), /binary data/);

    const pdf = "C:\\Research\\long.pdf";
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const longStore = new TaskAttachmentStore(
      fixtureIO(
        { [pdf]: pdfBytes },
        "x".repeat(MAX_ATTACHMENT_CHARACTERS + 20),
      ),
    );
    const record = await longStore.prepare(pdf);
    assert.equal(record.truncated, true);
    assert.equal(record.includedCharacters, MAX_ATTACHMENT_CHARACTERS);
  });

  it("consumes and expires opaque attachment ids", async () => {
    const path = "C:\\Research\\note.txt";
    const files = { [path]: new TextEncoder().encode("hello") };
    const store = new TaskAttachmentStore(fixtureIO(files));
    const record = await store.prepare(path);
    assert.equal(store.resolve([record.id]).length, 1);
    store.consume([record.id]);
    assert.throws(() => store.resolve([record.id]), /expired/);
  });
});
