import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderOrganizerReviewCard,
  cleanHeadingTitle,
  compareNumBadges,
  type ApprovalRowLike,
  type OrganizerReviewCardOptions,
} from "./organizerReviewCard";
import type { OrganizerAssignmentReview } from "@confucius/protocol";

// Lightweight DOM mock for Node.js test environment
class MockElement extends EventTarget {
  tagName: string;
  namespaceURI: string | null;
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  dataset: Record<string, string>;
  childNodes: MockElement[] = [];
  disabled = false;
  title = "";
  value = "";
  className = "";
  private _textContent = "";

  constructor(tagName: string, namespaceURI: string | null = null) {
    super();
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespaceURI;
    const rawDataset: Record<string, string> = {};
    this.dataset = new Proxy(rawDataset, {
      set: (target, prop: string, value: any) => {
        target[prop] = String(value);
        const kebab = "data-" + prop.replace(/([A-Z])/g, "-$1").toLowerCase();
        this.attributes.set(kebab, String(value));
        return true;
      },
      get: (target, prop: string) => target[prop],
    });
  }

  get textContent(): string {
    if (this.childNodes.length > 0) {
      return this.childNodes.map((c) => c.textContent).join("");
    }
    return this._textContent;
  }

  set textContent(val: string) {
    this._textContent = val;
    this.childNodes = [];
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) {
      const parts = name.slice(5).split("-");
      const camel =
        parts[0] +
        parts
          .slice(1)
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join("");
      this.dataset[camel] = String(value);
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild<T extends MockElement>(child: T): T {
    this.childNodes.push(child);
    return child;
  }

  append(...children: (MockElement | string)[]) {
    for (const c of children) {
      if (typeof c === "string") {
        const textNode = new MockElement("#text");
        textNode.textContent = c;
        this.childNodes.push(textNode);
      } else {
        this.childNodes.push(c);
      }
    }
  }

  removeChild<T extends MockElement>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    return child;
  }

  insertBefore<T extends MockElement>(
    newNode: T,
    refNode: MockElement | null,
  ): T {
    if (!refNode) {
      return this.appendChild(newNode);
    }
    const idx = this.childNodes.indexOf(refNode);
    if (idx >= 0) {
      this.childNodes.splice(idx, 0, newNode);
    } else {
      this.childNodes.push(newNode);
    }
    return newNode;
  }

  get firstChild(): MockElement | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): MockElement | null {
    return null;
  }

  get children(): MockElement[] {
    return this.childNodes.filter((c) => c.tagName !== "#TEXT");
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const walk = (node: MockElement) => {
      if (matches(node, selector)) {
        results.push(node);
      }
      for (const child of node.childNodes) {
        walk(child);
      }
    };
    for (const child of this.childNodes) {
      walk(child);
    }
    return results;
  }

  click() {
    this.dispatchEvent(new Event("click"));
  }
}

function matches(node: MockElement, selector: string): boolean {
  if (selector.startsWith(".")) {
    const cls = selector.slice(1);
    return node.className.split(/\s+/).includes(cls);
  }
  if (selector.startsWith("[") && selector.endsWith("]")) {
    const inner = selector.slice(1, -1);
    if (inner.includes("=")) {
      const [attr, val] = inner.split("=");
      const cleanVal = val.replace(/^["']|["']$/g, "");
      return node.getAttribute(attr) === cleanVal;
    }
    return node.getAttribute(inner) !== null;
  }
  if (selector.includes("[")) {
    const tag = selector.slice(0, selector.indexOf("[")).toUpperCase();
    const attrPart = selector.slice(selector.indexOf("["));
    return (tag === "" || node.tagName === tag) && matches(node, attrPart);
  }
  return node.tagName === selector.toUpperCase();
}

function createMockDoc(): Document {
  return {
    createElementNS(_ns: string, tag: string) {
      return new MockElement(tag, _ns) as unknown as HTMLElement;
    },
  } as unknown as Document;
}

const sampleReview: OrganizerAssignmentReview = {
  collectionKey: "COL_DISSERTATION",
  collectionTitle: "Dissertation",
  totalAssignments: 2,
  outlineHeadings: [
    { title: "Einleitung", num: "1", path: "Einleitung", tag: "§Einleitung" },
    {
      title: "Funktionen des Nachweises",
      num: "1.1",
      path: "Einleitung / Funktionen des Nachweises",
      tag: "§Funktionen des Nachweises",
    },
    {
      title: "Methode",
      num: "2",
      path: "Methode",
      tag: "§Methode",
    },
  ],
  items: [
    {
      key: "ANN_1",
      headings: [
        {
          title: "Funktionen des Nachweises",
          num: "1.1",
          path: "Einleitung / Funktionen des Nachweises",
          tag: "§Funktionen des Nachweises",
        },
      ],
      quote:
        "Quellenbelege dienen der Nachvollziehbarkeit wissenschaftlicher Thesen.",
      comment: "Wichtige Definition",
      page: "42",
      color: "#ffd400",
      sourceTitle: "Einführung in die Rechtswissenschaft",
      sourceCitation: "Müller (2021)",
      reason: "Passt zur Definition der Zitierfunktionen.",
    },
    {
      key: "ANN_2",
      headings: [
        {
          title: "Methode",
          num: "2",
          path: "Methode",
          tag: "§Methode",
        },
      ],
      quote: "Die empirische Erhebung basiert auf einer Fragebogenstudie.",
      page: "15",
      sourceTitle: "Empirische Rechtsforschung",
      sourceCitation: "Schmidt (2023)",
      reason: "Erläutert das methodische Vorgehen.",
    },
  ],
};

const sampleItem: ApprovalRowLike = {
  id: "approval_123",
  toolName: "organizer_assign_annotations",
  args: {
    collection: "Dissertation",
    assignments: [
      {
        key: "ANN_1",
        headings: ["Funktionen des Nachweises"],
        reason: "Passt zur Definition.",
      },
      { key: "ANN_2", headings: ["Methode"], reason: "Erläutert Methode." },
    ],
    dryRun: true,
  },
  organizerReview: sampleReview,
};

describe("renderOrganizerReviewCard", () => {
  it("renders review card with outline hierarchy, decimal numbers and item metadata", () => {
    const doc = createMockDoc();
    const resolved: unknown[] = [];
    const options: OrganizerReviewCardOptions = {
      resolve: (verdict, scope, editedArgs) => {
        resolved.push({ verdict, scope, editedArgs });
      },
      language: "de",
    };

    const card = renderOrganizerReviewCard(
      doc,
      sampleItem,
      options,
    ) as unknown as MockElement;

    assert.equal(
      card.className,
      "confucius-approval confucius-organizer-review-card",
    );
    assert.equal(
      card.getAttribute("aria-label"),
      "Flex Annotations · Gliederungs-Zuweisung",
    );
    assert.equal(card.getAttribute("data-review-kind"), "organizer-assignment");

    // Check heading sections exist with decimal numbering
    const text = card.textContent;
    assert.match(text, /Dissertation/);
    assert.match(text, /2 Vorschläge/);
    assert.match(text, /1\.1 Funktionen des Nachweises/);
    assert.match(text, /2 Methode/);

    // Check quote and citation text
    assert.match(text, /Quellenbelege dienen der Nachvollziehbarkeit/);
    assert.match(text, /Müller \(2021\) · S\. 42/);
    assert.match(
      text,
      /Die empirische Erhebung basiert auf einer Fragebogenstudie/,
    );
    assert.match(text, /Schmidt \(2023\) · S\. 15/);
  });

  it("toggles item acceptance and updates counters and visual state", () => {
    const doc = createMockDoc();
    const options: OrganizerReviewCardOptions = {
      resolve: () => {},
      language: "de",
    };

    const card = renderOrganizerReviewCard(
      doc,
      sampleItem,
      options,
    ) as unknown as MockElement;

    // Both items initially accepted
    const items = card.querySelectorAll("[data-status]");
    assert.equal(items.length, 2);
    assert.equal(items[0].getAttribute("data-status"), "accepted");
    assert.equal(items[1].getAttribute("data-status"), "accepted");

    // Find reject button on first item
    const firstRejectBtn =
      items[0].querySelector("button[data-action='reject']") ||
      items[0]
        .querySelectorAll("button")
        .find((b) => b.textContent.includes("Abweisen"));
    assert.ok(firstRejectBtn, "Reject button found");

    firstRejectBtn!.click();

    // After rejecting first item:
    assert.match(card.textContent, /1 angenommen/);
    assert.match(card.textContent, /1 abgewiesen/);
    assert.match(card.textContent, /✓ 1 Zuweisung anwenden/);
  });

  it("handles bulk actions: Alle abweisen and Alle annehmen", () => {
    const doc = createMockDoc();
    const options: OrganizerReviewCardOptions = {
      resolve: () => {},
      language: "de",
    };

    const card = renderOrganizerReviewCard(
      doc,
      sampleItem,
      options,
    ) as unknown as MockElement;

    const rejectAllBtn = card
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("Alle abweisen"));
    assert.ok(rejectAllBtn, "Bulk reject all button found");

    rejectAllBtn!.click();

    assert.match(card.textContent, /0 angenommen/);
    assert.match(card.textContent, /2 abgewiesen/);

    // Apply button disabled when 0 accepted
    const applyBtn = card
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("anwenden"));
    assert.ok(applyBtn, "Apply button found");
    assert.equal(applyBtn!.disabled, true);

    const acceptAllBtn = card
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("Alle annehmen"));
    assert.ok(acceptAllBtn, "Bulk accept all button found");

    acceptAllBtn!.click();
    assert.match(card.textContent, /2 angenommen/);
    assert.match(card.textContent, /0 abgewiesen/);
    assert.equal(applyBtn!.disabled, false);
  });

  it("filters items by status tabs (Alle, Angenommen, Abgewiesen)", () => {
    const doc = createMockDoc();
    const options: OrganizerReviewCardOptions = {
      resolve: () => {},
      language: "de",
    };

    const card = renderOrganizerReviewCard(
      doc,
      sampleItem,
      options,
    ) as unknown as MockElement;

    // Reject the first item
    const items = card.querySelectorAll("[data-status]");
    const firstRejectBtn = items[0]
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("Abweisen"));
    firstRejectBtn!.click();

    // Find tabs
    const buttons = card.querySelectorAll("button");
    const acceptedTab = buttons.find((b) =>
      b.textContent.includes("Angenommen (1)"),
    );
    const rejectedTab = buttons.find((b) =>
      b.textContent.includes("Abgewiesen (1)"),
    );
    const allTab = buttons.find((b) => b.textContent.includes("Alle (2)"));

    assert.ok(acceptedTab);
    assert.ok(rejectedTab);
    assert.ok(allTab);

    // Switch to Accepted tab -> only ANN_2 should be visible
    acceptedTab!.click();
    const visibleAccepted = card.querySelectorAll("[data-status]");
    assert.equal(visibleAccepted.length, 1);
    assert.equal(visibleAccepted[0].getAttribute("data-key"), "ANN_2");

    // Switch to Rejected tab -> only ANN_1 should be visible
    rejectedTab!.click();
    const visibleRejected = card.querySelectorAll("[data-status]");
    assert.equal(visibleRejected.length, 1);
    assert.equal(visibleRejected[0].getAttribute("data-key"), "ANN_1");

    // Switch back to All
    allTab!.click();
    assert.equal(card.querySelectorAll("[data-status]").length, 2);
  });

  it("commits approval with filtered assignments and dryRun: false", () => {
    const doc = createMockDoc();
    let committedVerdict = "";
    let committedScope = "";
    let committedArgs: Record<string, unknown> | undefined;

    const options: OrganizerReviewCardOptions = {
      resolve: (verdict, scope, editedArgs) => {
        committedVerdict = verdict;
        committedScope = scope;
        committedArgs = editedArgs;
      },
      language: "de",
    };

    const card = renderOrganizerReviewCard(
      doc,
      sampleItem,
      options,
    ) as unknown as MockElement;

    // Reject ANN_1 so only ANN_2 is approved
    const items = card.querySelectorAll("[data-status]");
    const firstRejectBtn = items[0]
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("Abweisen"));
    firstRejectBtn!.click();

    // Click Apply button
    const applyBtn = card
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("anwenden"));
    assert.ok(applyBtn);
    applyBtn!.click();

    assert.equal(committedVerdict, "allow");
    assert.equal(committedScope, "once");
    assert.ok(committedArgs);
    assert.equal(
      committedArgs!.dryRun,
      false,
      "dryRun must be set to false on approval",
    );

    const assignments = committedArgs!.assignments as Array<{ key: string }>;
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].key, "ANN_2");
  });

  it("handles deny all action correctly", () => {
    const doc = createMockDoc();
    let committedVerdict = "";
    let committedScope = "";

    const options: OrganizerReviewCardOptions = {
      resolve: (verdict, scope) => {
        committedVerdict = verdict;
        committedScope = scope;
      },
      language: "de",
    };

    const card = renderOrganizerReviewCard(
      doc,
      sampleItem,
      options,
    ) as unknown as MockElement;

    const denyBtn = card
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("Alle ablehnen"));
    assert.ok(denyBtn);
    denyBtn!.click();

    assert.equal(committedVerdict, "deny");
    assert.equal(committedScope, "once");
  });

  it("invokes locate callback when citation link is clicked", () => {
    const doc = createMockDoc();
    const locatedKeys: string[] = [];

    const options: OrganizerReviewCardOptions = {
      resolve: () => {},
      locate: (key) => {
        locatedKeys.push(key);
      },
      language: "de",
    };

    const card = renderOrganizerReviewCard(
      doc,
      sampleItem,
      options,
    ) as unknown as MockElement;

    const citeLinks = card
      .querySelectorAll("button")
      .filter((b) => b.textContent.includes("Müller"));
    assert.ok(citeLinks.length > 0, "Citation link found");
    citeLinks[0].click();

    assert.deepEqual(locatedKeys, ["ANN_1"]);
  });

  it("handles duplicate keys across distinct assignments without counter or toggle collisions", () => {
    const doc = createMockDoc();
    let resolvedArgs: Record<string, unknown> | undefined;

    const dupItem: ApprovalRowLike = {
      id: "approval_dup",
      toolName: "organizer_assign_annotations",
      args: {
        collection: "Dissertation",
        assignments: [
          {
            key: "SAME_KEY",
            headings: ["Funktionen des Nachweises"],
            reason: "Aspect A",
          },
          { key: "SAME_KEY", headings: ["Methode"], reason: "Aspect B" },
        ],
      },
      organizerReview: {
        collectionTitle: "Dissertation",
        totalAssignments: 2,
        outlineHeadings: sampleReview.outlineHeadings,
        items: [
          {
            key: "SAME_KEY",
            headings: [{ title: "Funktionen des Nachweises", num: "1.1" }],
            quote: "Aspect A quote",
          },
          {
            key: "SAME_KEY",
            headings: [{ title: "Methode", num: "2" }],
            quote: "Aspect B quote",
          },
        ],
      },
    };

    const card = renderOrganizerReviewCard(doc, dupItem, {
      resolve: (_verdict, _scope, edited) => {
        resolvedArgs = edited;
      },
      language: "de",
    }) as unknown as MockElement;

    // Initial tally must be 2 total, 2 accepted, 0 rejected (no key collision!)
    assert.match(
      card.textContent,
      /2 Vorschläge · 2 angenommen · 0 abgewiesen/,
    );

    const items = card.querySelectorAll("[data-status]");
    assert.equal(items.length, 2);

    // Reject only the first item
    const firstReject = items[0]
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("Abweisen"));
    assert.ok(firstReject);
    firstReject!.click();

    // Now tally must be 1 accepted, 1 rejected
    assert.match(
      card.textContent,
      /2 Vorschläge · 1 angenommen · 1 abgewiesen/,
    );

    // Click apply
    const applyBtn = card
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("anwenden"));
    assert.ok(applyBtn);
    applyBtn!.click();

    assert.ok(resolvedArgs);
    const resultAssignments = resolvedArgs!.assignments as Array<{
      key: string;
      reason: string;
    }>;
    assert.equal(resultAssignments.length, 1);
    assert.equal(resultAssignments[0].key, "SAME_KEY");
    assert.equal(resultAssignments[0].reason, "Aspect B");
  });

  it("handles organizer unassign with args.keys and strips keys/key in editedArgs", () => {
    const doc = createMockDoc();
    let resolvedArgs: Record<string, unknown> | undefined;

    const unassignItem: ApprovalRowLike = {
      id: "approval_unassign",
      toolName: "organizer_unassign_annotations",
      args: {
        collection: "Dissertation",
        keys: ["ANN_A", "ANN_B"],
      },
    };

    const card = renderOrganizerReviewCard(doc, unassignItem, {
      resolve: (_verdict, _scope, edited) => {
        resolvedArgs = edited;
      },
      language: "de",
    }) as unknown as MockElement;

    assert.match(
      card.textContent,
      /2 Vorschläge · 2 angenommen · 0 abgewiesen/,
    );

    // Reject ANN_A
    const items = card.querySelectorAll("[data-status]");
    assert.equal(items.length, 2);
    const rejectA = items[0]
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("Abweisen"));
    rejectA!.click();

    const applyBtn = card
      .querySelectorAll("button")
      .find((b) => b.textContent.includes("anwenden"));
    applyBtn!.click();

    assert.ok(resolvedArgs);
    assert.equal(
      "keys" in resolvedArgs!,
      false,
      "keys property should be removed from editedArgs",
    );
    assert.equal(
      "key" in resolvedArgs!,
      false,
      "key property should be removed from editedArgs",
    );
    const resultAssignments = resolvedArgs!.assignments as Array<{
      key: string;
    }>;
    assert.equal(resultAssignments.length, 1);
    assert.equal(resultAssignments[0].key, "ANN_B");
  });

  it("preserves canonical outline order from review.outlineHeadings", () => {
    const doc = createMockDoc();

    const disorderedReview: OrganizerAssignmentReview = {
      collectionTitle: "Recht",
      totalAssignments: 2,
      outlineHeadings: [
        { title: "Grundlagen", num: "1" },
        { title: "Spezialprobleme", num: "2" },
      ],
      // Items provided in reverse order
      items: [
        {
          key: "ANN_SPEC",
          headings: [{ title: "Spezialprobleme", num: "2" }],
          quote: "Detail",
        },
        {
          key: "ANN_BASE",
          headings: [{ title: "Grundlagen", num: "1" }],
          quote: "Basis",
        },
      ],
    };

    const card = renderOrganizerReviewCard(
      doc,
      {
        id: "approval_order",
        toolName: "organizer_assign_annotations",
        args: { collection: "Recht", assignments: [] },
        organizerReview: disorderedReview,
      },
      {
        resolve: () => {},
        language: "de",
      },
    ) as unknown as MockElement;

    const sections = card.querySelectorAll("section");
    assert.equal(sections.length, 2);
    // First section in DOM should be Chapter 1 Grundlagen
    assert.match(sections[0].textContent, /1 Grundlagen/);
    assert.match(sections[1].textContent, /2 Spezialprobleme/);
  });

  it("shows multi-assignment badge (+ § Heading) in grouped view when annotation has multiple headings", () => {
    const doc = createMockDoc();

    const multiHeadingReview: OrganizerAssignmentReview = {
      collectionTitle: "Methodik",
      totalAssignments: 1,
      outlineHeadings: [
        { title: "Theorie", num: "1" },
        { title: "Empirie", num: "2" },
      ],
      items: [
        {
          key: "ANN_MULTI",
          headings: [
            { title: "Theorie", num: "1" },
            { title: "Empirie", num: "2" },
          ],
          quote: "Brückentext zwischen Theorie und Empirie",
        },
      ],
    };

    const card = renderOrganizerReviewCard(
      doc,
      {
        id: "approval_multi",
        toolName: "organizer_assign_annotations",
        args: { collection: "Methodik", assignments: [] },
        organizerReview: multiHeadingReview,
      },
      {
        resolve: () => {},
        language: "de",
      },
    ) as unknown as MockElement;

    // Both groups are rendered
    const sections = card.querySelectorAll("section");
    assert.equal(sections.length, 2);

    // In the Theorie section, it should indicate + § 2 Empirie
    assert.match(sections[0].textContent, /\+ § 2 Empirie/);
    // In the Empirie section, it should indicate + § 1 Theorie
    assert.match(sections[1].textContent, /\+ § 1 Theorie/);
  });

  it("supports English and Chinese localization", () => {
    const doc = createMockDoc();
    const cardEn = renderOrganizerReviewCard(doc, sampleItem, {
      resolve: () => {},
      language: "en-US",
    }) as unknown as MockElement;
    assert.equal(
      cardEn.getAttribute("aria-label"),
      "Flex Annotations · Outline Assignment",
    );
    assert.match(cardEn.textContent, /2 proposed · 2 accepted · 0 rejected/);

    const cardZh = renderOrganizerReviewCard(doc, sampleItem, {
      resolve: () => {},
      language: "zh-CN",
    }) as unknown as MockElement;
    assert.equal(
      cardZh.getAttribute("aria-label"),
      "Flex Annotations · 大纲归类",
    );
    assert.match(cardZh.textContent, /2 条提案 · 2 条接受 · 0 条拒绝/);
  });

  it("skips empty ghost headings and assigns whitespace-only headings to unassigned", () => {
    const doc = createMockDoc();
    const ghostItem: ApprovalRowLike = {
      id: "approval_ghost",
      toolName: "organizer_assign_annotations",
      args: {
        collection: "Dissertation",
        assignments: [
          {
            key: "ANN_EMPTY",
            headings: ["", "   "],
            reason: "Empty heading test",
          },
        ],
      },
      organizerReview: {
        collectionTitle: "Dissertation",
        totalAssignments: 1,
        items: [
          {
            key: "ANN_EMPTY",
            headings: [{ title: "" }, { title: "   " }],
            quote: "A quote without proper heading",
            reason: "Empty heading test",
          },
        ],
      },
    };

    const card = renderOrganizerReviewCard(doc, ghostItem, {
      resolve: () => {},
      language: "de",
    }) as unknown as MockElement;

    // It should render under Ohne Überschrift, not an empty box
    assert.match(card.textContent, /Ohne Überschrift/);
    const sections = card.querySelectorAll("section");
    assert.equal(sections.length, 1);
    assert.doesNotMatch(sections[0].textContent, /^\s*\(\d+\)\s*$/);
  });

  it("renders prominent decimal badges and full outline breadcrumb path", () => {
    const doc = createMockDoc();
    const card = renderOrganizerReviewCard(doc, sampleItem, {
      resolve: () => {},
      language: "de",
    }) as unknown as MockElement;

    const sections = card.querySelectorAll("section");
    assert.equal(sections.length, 2);

    // Section 1: 1.1 Funktionen des Nachweises
    const sec1Text = sections[0].textContent;
    assert.match(sec1Text, /1\.1/);
    assert.match(sec1Text, /Funktionen des Nachweises/);
    assert.match(sec1Text, /Einleitung \/ Funktionen des Nachweises/);
    assert.match(sec1Text, /\(1\)/);

    // Section 2: 2 Methode
    const sec2Text = sections[1].textContent;
    assert.match(sec2Text, /2/);
    assert.match(sec2Text, /Methode/);
  });

  it("extracts decimal numbers and rationales from fallback args when organizerReview is omitted", () => {
    const doc = createMockDoc();
    const fallbackItem: ApprovalRowLike = {
      id: "approval_fallback",
      toolName: "organizer_assign_annotations",
      args: {
        collection: "Dissertation",
        assignments: [
          {
            key: "ANN_FB",
            headings: ["1.2 Stand der Forschung"],
            rationale: "Fasst bisherige Studien zusammen",
            text: "Bisherige Ansätze greifen zu kurz.",
          },
        ],
      },
    };

    const card = renderOrganizerReviewCard(doc, fallbackItem, {
      resolve: () => {},
      language: "de",
    }) as unknown as MockElement;

    assert.match(card.textContent, /1\.2 Stand der Forschung/);
    assert.match(card.textContent, /“Bisherige Ansätze greifen zu kurz\.”/);
    assert.doesNotMatch(card.textContent, /Begründung:/);
    assert.doesNotMatch(card.textContent, /Reason:/);

    // Fallback when quote text is omitted: rationale is rendered directly as quote without Reason prefix
    const doc2 = createMockDoc();
    const fallbackWithoutText: ApprovalRowLike = {
      id: "approval_fallback_2",
      toolName: "organizer_assign_annotations",
      args: {
        collection: "Dissertation",
        assignments: [
          {
            key: "ANN_FB2",
            headings: ["1.2 Stand der Forschung"],
            rationale: "Fasst bisherige Studien zusammen",
          },
        ],
      },
    };
    const card2 = renderOrganizerReviewCard(doc2, fallbackWithoutText, {
      resolve: () => {},
      language: "de",
    }) as unknown as MockElement;
    assert.match(card2.textContent, /“Fasst bisherige Studien zusammen”/);
    assert.doesNotMatch(card2.textContent, /Begründung:/);
  });

  it("handles edge cases in cleanHeadingTitle without false matches on normal words", () => {
    // German phrases starting with "Im" or "In" should not be treated as Roman numerals
    assert.deepEqual(cleanHeadingTitle("Im Überblick"), {
      title: "Im Überblick",
    });
    assert.deepEqual(cleanHeadingTitle("In dieser Arbeit"), {
      title: "In dieser Arbeit",
    });

    // English sentences starting with article "A" should not be treated as outline letters
    assert.deepEqual(cleanHeadingTitle("A Study in Scarlet"), {
      title: "A Study in Scarlet",
    });

    // Delimited letters and Roman numerals should be recognized
    assert.deepEqual(cleanHeadingTitle("A. Grundlagen"), {
      num: "A",
      title: "Grundlagen",
    });
    assert.deepEqual(cleanHeadingTitle("I. Einleitung"), {
      num: "I",
      title: "Einleitung",
    });
    assert.deepEqual(cleanHeadingTitle("a) Detail"), {
      num: "a",
      title: "Detail",
    });
    assert.deepEqual(cleanHeadingTitle("II Hauptteil"), {
      num: "II",
      title: "Hauptteil",
    });

    // Decimal numbers with and without trailing dots
    assert.deepEqual(cleanHeadingTitle("1.1 Funktionen des Nachweises"), {
      num: "1.1",
      title: "Funktionen des Nachweises",
    });
    assert.deepEqual(cleanHeadingTitle("1. Funktionen des Nachweises"), {
      num: "1",
      title: "Funktionen des Nachweises",
    });
    assert.deepEqual(cleanHeadingTitle("1 Funktionen des Nachweises"), {
      num: "1",
      title: "Funktionen des Nachweises",
    });
  });

  it("sorts outline number badges naturally with compareNumBadges", () => {
    assert.equal(compareNumBadges("1.2", "1.10") < 0, true);
    assert.equal(compareNumBadges("1.1", "1.2") < 0, true);
    assert.equal(compareNumBadges("1.1", "1.1.1") < 0, true);
    assert.equal(compareNumBadges("A.", "B.") < 0, true);
    assert.equal(compareNumBadges(undefined, "1") > 0, true);
    assert.equal(compareNumBadges("1", undefined) < 0, true);
  });

  it("configures scrollable containers for accordions and hides raw keys from display", () => {
    const doc = createMockDoc();
    const item: ApprovalRowLike = {
      id: "approval_scroll_test",
      toolName: "organizer_assign_annotations",
      args: {
        collection: "BGB AT",
      },
      organizerReview: {
        collectionTitle: "BGB AT",
        totalAssignments: 2,
        outlineHeadings: [
          { num: "2.1", title: "Grundsätze der Auslegung", path: "2 > 2.1" },
        ],
        items: [
          {
            key: "SECRET_KEY_123",
            headings: [{ num: "2.1", title: "Grundsätze der Auslegung" }],
            quote: "Ein Vertrag kommt durch Willenserklärungen zustande.",
            comment: "Zentrale Definition",
            sourceTitle: "Baur/Stürner",
            sourceCitation: "Baur/Stürner (2020)",
            page: "45",
          },
        ],
      },
    };

    const card = renderOrganizerReviewCard(doc, item, {
      resolve: () => {},
      language: "de",
    }) as unknown as MockElement;

    // 1. Raw ID should NOT be displayed as text in the card
    assert.doesNotMatch(card.textContent, /SECRET_KEY_123/);
    assert.doesNotMatch(card.textContent, /\[SECRET_KEY_123\]/);

    // 2. Quote, comment, source citation and page should be present
    assert.match(card.textContent, /“Ein Vertrag kommt durch Willenserklärungen zustande\.”/);
    assert.match(card.textContent, /Zentrale Definition/);
    assert.match(card.textContent, /Baur\/Stürner \(2020\) · S\. 45/);

    // 3. Section should have flexShrink 0 to prevent accordion collapsing
    const section = card.querySelector("section");
    assert.ok(section, "section should exist");
    assert.equal(section.style.flexShrink, "0");

    // 4. Accordion itemsWrapper should be scrollable with data-confucius-scroll
    const itemsWrapper = section.querySelector("[data-heading-scroll]");
    assert.ok(itemsWrapper, "itemsWrapper should exist with data-heading-scroll");
    assert.equal(itemsWrapper.style.maxHeight, "360px");
    assert.equal(itemsWrapper.style.overflowY, "auto");
    assert.equal(itemsWrapper.getAttribute("data-confucius-scroll"), "");

    // 5. itemRow should have flexShrink 0
    const article = itemsWrapper.querySelector("article");
    assert.ok(article, "article should exist");
    assert.equal(article.style.flexShrink, "0");
  });

  it("does not render duplicate breadcrumbs when path is identical to heading with or without number", () => {
    const doc = createMockDoc();
    const item: ApprovalRowLike = {
      id: "approval_dup_test",
      toolName: "organizer_assign_annotations",
      args: { collection: "BGB" },
      organizerReview: {
        collectionTitle: "BGB",
        totalAssignments: 1,
        outlineHeadings: [
          {
            num: "2.1",
            title: "Funktionen des Quellennachweises",
            path: "2.1 Funktionen des Quellennachweises",
          },
        ],
        items: [
          {
            key: "K1",
            headings: [{ num: "2.1", title: "Funktionen des Quellennachweises" }],
            quote: "Test Zitat",
          },
        ],
      },
    };

    const card = renderOrganizerReviewCard(doc, item, {
      resolve: () => {},
      language: "de",
    }) as unknown as MockElement;

    // Breadcrumb symbol "›" must NOT be rendered because there are no ancestors
    assert.doesNotMatch(card.textContent, /›/);
  });

  it("applies subtle font weight to citations, spaces scrollbars, and preserves DOM in-place on reject", () => {
    const doc = createMockDoc();
    const item: ApprovalRowLike = {
      id: "approval_style_scroll_test",
      toolName: "organizer_assign_annotations",
      args: { collection: "BGB" },
      organizerReview: {
        collectionTitle: "BGB",
        totalAssignments: 1,
        outlineHeadings: [
          {
            num: "1",
            title: "Einleitung",
          },
        ],
        items: [
          {
            key: "ITEM_1",
            headings: [{ num: "1", title: "Einleitung" }],
            quote: "Test Zitat für Styling",
            sourceCitation: "Medicus/Petersen (2021)",
            page: "12",
          },
        ],
      },
    };

    let locateKey: string | null = null;
    const card = renderOrganizerReviewCard(doc, item, {
      resolve: () => {},
      locate: (k) => {
        locateKey = k;
      },
      language: "de",
    }) as unknown as MockElement;

    // 1. Citation link has subtle weight (400)
    const citeButton = card
      .querySelectorAll("button")
      .find((b) => b.textContent?.includes("Medicus/Petersen"));
    assert.ok(citeButton, "citation button should exist");
    assert.equal(citeButton.style.fontWeight, "400");
    citeButton.click();
    assert.equal(locateKey, "ITEM_1");

    // 2. Section has right margin and itemsWrapper has padding for scrollbar separation
    const section = card.querySelector("section");
    assert.ok(section, "section should exist");
    assert.equal(section.style.marginRight, "6px");

    const itemsWrapper = section.querySelector("[data-heading-scroll]");
    assert.ok(itemsWrapper, "itemsWrapper should exist");
    assert.equal(itemsWrapper.style.padding, "6px 12px 6px 6px");

    // 3. Rejecting an item in "all" view modifies in-place without remounting the article
    const article = itemsWrapper.querySelector("article");
    assert.ok(article, "article should exist");
    const initialArticleRef = article;

    const rejectBtn = Array.from(article.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Abweisen"),
    );
    assert.ok(rejectBtn, "reject button should exist");

    rejectBtn.click();

    const afterArticle = itemsWrapper.querySelector("article");
    assert.strictEqual(
      afterArticle,
      initialArticleRef,
      "article DOM element must remain the exact same reference (no remounting/scroll jump)",
    );
    assert.equal(article.dataset.status, "rejected");
  });
});
