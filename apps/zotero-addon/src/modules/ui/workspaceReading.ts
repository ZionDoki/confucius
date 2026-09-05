import {
  annotationsFromBody,
  DEFAULT_ANNOTATION_COLORS,
  type ArtifactBody,
} from "@confucius/protocol";
import { getString } from "../../utils/locale";
function el(
  doc: Document,
  tag: string,
  style?: Record<string, string>,
): HTMLElement {
  const node = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElement;
  if (style) Object.assign(node.style, style);
  return node;
}
export function renderReadingSurface(
  doc: Document,
  body: ArtifactBody,
  helpers: {
    fillAnswerHtml: (node: HTMLElement, text: string) => void;
    locateLink: (
      doc: Document,
      target: { libraryID?: number; key: string; pageIndex?: number },
    ) => HTMLElement;
  },
): HTMLElement {
  const { fillAnswerHtml, locateLink } = helpers;
  const container = el(doc, "div");
  container.className = "confucius-reading-surface";
  if (body.type === "markdown") {
    container.className = "tui-answer confucius-reading-surface";
    fillAnswerHtml(container, body.markdown);
    return container;
  }
  const table = (
    headers: string[],
    rows: Array<Array<string | HTMLElement>>,
  ): HTMLElement => {
    const node = el(doc, "table");
    const head = el(doc, "thead");
    const headRow = el(doc, "tr");
    for (const label of headers) {
      const cell = el(doc, "th");
      cell.textContent = label;
      headRow.appendChild(cell);
    }
    head.appendChild(headRow);
    node.appendChild(head);
    const tbody = el(doc, "tbody");
    for (const values of rows) {
      const row = el(doc, "tr");
      for (const value of values) {
        const cell = el(doc, "td");
        if (typeof value === "string") cell.textContent = value;
        else cell.appendChild(value);
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    node.appendChild(tbody);
    return node;
  };
  if (body.type === "evidence_audit") {
    const fourColumn = body.claims.some(
      (claim) => claim.evidence !== undefined || claim.risk !== undefined,
    );
    container.appendChild(
      fourColumn
        ? table(
            [
              getString("workspace-artifact-claim"),
              getString("workspace-artifact-evidence"),
              getString("workspace-artifact-verdict"),
              getString("workspace-artifact-risk"),
            ],
            body.claims.map((claim) => [
              claim.claim,
              claim.evidence ?? claim.rationale ?? "",
              claim.verdict,
              claim.risk ?? "",
            ]),
          )
        : table(
            [
              getString("workspace-artifact-claim"),
              getString("workspace-artifact-verdict"),
              getString("workspace-artifact-rationale"),
            ],
            body.claims.map((claim) => [
              claim.claim,
              claim.verdict,
              claim.rationale ?? "",
            ]),
          ),
    );
  } else if (body.type === "literature_map") {
    const nodes = el(doc, "div", { marginBottom: "18px" });
    for (const node of body.nodes) {
      const row = el(doc, "div", {
        padding: "8px 0",
        borderBottom: "1px solid #ece8df",
      });
      const name = el(doc, "strong");
      name.textContent = node.label;
      row.appendChild(name);
      if (node.summary) {
        const summary = el(doc, "div", { color: "#6b665c" });
        summary.textContent = node.summary;
        row.appendChild(summary);
      }
      if (node.item) {
        row.appendChild(
          locateLink(doc, { ...node.item, pageIndex: undefined }),
        );
      }
      nodes.appendChild(row);
    }
    container.appendChild(nodes);
    container.appendChild(
      table(
        [
          getString("workspace-artifact-from"),
          getString("workspace-artifact-relation"),
          getString("workspace-artifact-to"),
        ],
        body.edges.map((edge) => [edge.source, edge.relation, edge.target]),
      ),
    );
  } else if (body.type === "triage_table") {
    container.appendChild(
      table(
        [
          getString("workspace-artifact-source"),
          getString("workspace-artifact-decision"),
          getString("workspace-artifact-reason"),
        ],
        body.rows.map((row) => {
          const source = el(doc, "div");
          const title = el(doc, "div", { fontWeight: "600" });
          title.textContent = row.title;
          source.appendChild(title);
          source.appendChild(locateLink(doc, row.item));
          return [source, row.decision, row.reason];
        }),
      ),
    );
  } else if (body.type === "annotation_set") {
    const legend = body.legend?.length
      ? body.legend
      : [
          {
            type: "highlight" as const,
            color: DEFAULT_ANNOTATION_COLORS.highlight,
            meaning: getString(
              "workspace-artifact-annotation-highlight-default",
            ),
          },
          {
            type: "underline" as const,
            color: DEFAULT_ANNOTATION_COLORS.underline,
            meaning: getString(
              "workspace-artifact-annotation-underline-default",
            ),
          },
          {
            type: "image" as const,
            color: DEFAULT_ANNOTATION_COLORS.image,
            meaning: getString("workspace-artifact-annotation-image-default"),
          },
        ];
    const legendHeading = el(doc, "div", {
      marginBottom: "7px",
      color: "#6b665c",
      fontSize: "11px",
      fontWeight: "700",
      letterSpacing: ".06em",
      textTransform: "uppercase",
    });
    legendHeading.textContent = getString(
      "workspace-artifact-annotation-legend",
    );
    container.appendChild(legendHeading);
    const legendList = el(doc, "div", {
      marginBottom: "18px",
      borderTop: "1px solid #e5e1d8",
    });
    for (const entry of legend) {
      const row = el(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "7px 0",
        borderBottom: "1px solid #eeeae2",
        color: "#575249",
        fontSize: ".9em",
      });
      const swatch = el(doc, "span", {
        width: "10px",
        height: "10px",
        flex: "0 0 10px",
        borderRadius: "3px",
        background: entry.color ?? DEFAULT_ANNOTATION_COLORS[entry.type],
        boxShadow: "inset 0 0 0 1px rgba(28,25,23,.12)",
      });
      const label = el(doc, "strong", { color: "#33302a" });
      label.textContent = getString(
        `workspace-artifact-annotation-${entry.type}`,
      );
      row.appendChild(swatch);
      row.appendChild(label);
      row.appendChild(doc.createTextNode(entry.meaning));
      legendList.appendChild(row);
    }
    container.appendChild(legendList);

    for (const annotation of annotationsFromBody(body)) {
      const color =
        annotation.color ?? DEFAULT_ANNOTATION_COLORS[annotation.type];
      const annotationNode = el(doc, "section", {
        marginBottom: "16px",
        padding: "0 0 16px 14px",
        borderLeft: `3px solid ${color}`,
        borderBottom: "1px solid #eeeae2",
      });
      const meta = el(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "7px",
        marginBottom: "7px",
        color: "#777166",
        fontSize: ".82em",
      });
      const type = el(doc, "strong", { color: "#4b4740" });
      type.textContent = getString(
        `workspace-artifact-annotation-${annotation.type}`,
      );
      meta.appendChild(type);
      meta.appendChild(doc.createTextNode(`p. ${annotation.page}`));
      annotationNode.appendChild(meta);
      if (annotation.type === "image") {
        const region = el(doc, "div", {
          position: "relative",
          width: "112px",
          height: "148px",
          margin: "4px 0 9px",
          overflow: "hidden",
          border: "1px solid #d8d1c4",
          borderRadius: "4px",
          background:
            "repeating-linear-gradient(0deg,#faf9f6,#faf9f6 11px,#f0ece3 12px)",
        });
        const [x, y, width, height] = annotation.rect;
        const crop = el(doc, "span", {
          position: "absolute",
          left: `${x / 10}%`,
          top: `${y / 10}%`,
          width: `${width / 10}%`,
          height: `${height / 10}%`,
          boxSizing: "border-box",
          border: `2px solid ${color}`,
          background: `${color}2b`,
        });
        region.appendChild(crop);
        region.setAttribute(
          "title",
          `${getString("workspace-artifact-annotation-region")}: ${annotation.rect.join(", ")}`,
        );
        annotationNode.appendChild(region);
      } else {
        const quote = el(doc, "div", {
          marginBottom: annotation.comment ? "7px" : "0",
          padding: annotation.type === "highlight" ? "2px 4px" : "2px 0",
          background:
            annotation.type === "highlight" ? `${color}38` : "transparent",
          textDecoration:
            annotation.type === "underline" ? "underline" : "none",
          textDecorationColor: color,
          textDecorationThickness: "2px",
          textUnderlineOffset: "3px",
        });
        quote.textContent = `“${annotation.quote}”`;
        annotationNode.appendChild(quote);
      }
      if (annotation.comment) {
        const comment = el(doc, "div", {
          color: "#575249",
          lineHeight: "1.5",
        });
        comment.textContent = annotation.comment;
        annotationNode.appendChild(comment);
      }
      container.appendChild(annotationNode);
    }
  } else if (body.type === "collection_diff") {
    container.appendChild(
      table(
        [
          getString("workspace-artifact-operation"),
          getString("workspace-artifact-target"),
        ],
        body.operations.map((operation) => [
          operation.op,
          operation.item
            ? `${operation.item.libraryID}:${operation.item.key}`
            : (operation.value ?? ""),
        ]),
      ),
    );
  } else if (body.type === "citation_list") {
    const list = el(doc, "ol", { paddingLeft: "24px" });
    for (const entry of body.entries) {
      const item = el(doc, "li", { marginBottom: "10px" });
      item.textContent = entry.rendered;
      list.appendChild(item);
    }
    container.appendChild(list);
  }
  return container;
}
