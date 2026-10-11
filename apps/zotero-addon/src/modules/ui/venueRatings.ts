import type {
  LiteratureWork,
  VenueRating,
  VenueRatingCatalogState,
  VenueRatingSystem,
} from "@confucius/protocol";
import { getString } from "../../utils/locale";
import { createWorkspaceButton } from "./workspaceControls";

type Rpc = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
const text = (key: string) => getString(`workspace-literature-ratings-${key}`);
function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  label?: string,
) {
  const element = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
  if (label) element.textContent = label;
  return element;
}
function systemName(system: VenueRatingSystem): string {
  return system === "cas" || system === "xr"
    ? text(system)
    : system.toUpperCase();
}
function rankLabel(rating: Pick<VenueRating, "system" | "rank">): string {
  if (!rating.rank) return text("no-quartile");
  return ["cas", "xr"].includes(rating.system)
    ? rating.rank
        .split(" / ")
        .map((rank) => text("partition").replace("%n", rank))
        .join(" / ")
    : rating.rank;
}
function sourceLink(doc: Document, rating: VenueRating, role = "badge") {
  const link = node(doc, "a", rating.source.name);
  link.dataset.action = `rating-source-${rating.system}-${role}`;
  // Catalog data and imported filenames are text; only HTTPS source URLs are actionable.
  if (/^https:\/\//i.test(rating.source.url)) {
    link.href = rating.source.url;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      Zotero.launchURL(link.href);
    });
  }
  if (rating.source.filename) link.title = rating.source.filename;
  return link;
}

/** Identical content in cards and list rows, retaining every subject's quartile. */
export function createVenueRatings(
  doc: Document,
  work: LiteratureWork,
  open = false,
  view: "summary" | "details" | "all" = "all",
) {
  const section = node(doc, "div");
  section.className = "confucius-venue-ratings";
  const ratings = work.venueRatings ?? [];
  if (ratings.length) {
    const badges = node(doc, "div");
    badges.className = "confucius-venue-rating-badges";
    for (const rating of ratings) {
      const badge = node(doc, "span");
      badge.className = "confucius-venue-rating";
      badge.dataset.system = rating.system;
      badge.append(
        node(
          doc,
          "strong",
          `${systemName(rating.system)} ${rankLabel(rating)}`,
        ),
        node(doc, "span", String(rating.year)),
        sourceLink(doc, rating),
      );
      badges.append(badge);
    }
    const details = node(doc, "details");
    details.className = "confucius-venue-rating-details";
    details.open = open;
    const summary = node(doc, "summary", text("details"));
    summary.dataset.action = "ratings-details";
    details.append(summary, node(doc, "p", text("scope")));
    for (const rating of ratings) {
      const heading = node(
        doc,
        "p",
        `${systemName(rating.system)} · ${rating.year}`,
      );
      const source = sourceLink(doc, rating, "details");
      heading.append(" · ", source);
      if (rating.source.filename)
        heading.append(` · ${rating.source.filename}`);
      if (rating.impactFactor) heading.append(` · IF ${rating.impactFactor}`);
      details.append(heading);
      if (rating.source.snapshotUrl) {
        const snapshot = sourceLink(
          doc,
          {
            ...rating,
            source: { name: text("snapshot"), url: rating.source.snapshotUrl },
          },
          "snapshot",
        );
        details.append(snapshot);
      }
      const categories = node(doc, "ul");
      for (const category of rating.categories) {
        categories.append(
          node(
            doc,
            "li",
            [
              ["major", "minor"].includes(category.scope)
                ? text(category.scope)
                : undefined,
              category.name,
              rankLabel({ system: rating.system, rank: category.rank }),
              category.top ? "Top" : undefined,
              category.position,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        );
      }
      if (categories.childNodes.length) details.append(categories);
    }
    if (view !== "details") section.append(badges);
    if (view !== "summary") section.append(details);
  } else if (view !== "details") {
    const missing = node(doc, "p", text("unmatched"));
    missing.className = "confucius-literature-meta";
    missing.title = text("scope");
    section.append(missing);
  }
  if (view !== "details" && work.venueRatingStatus === "unavailable") {
    const unavailable = node(doc, "p", text("unavailable"));
    unavailable.className = "confucius-literature-meta";
    section.append(unavailable);
  }
  return section;
}

/** Reused by Runtime settings and the collapsed review tool; imports stay host-local. */
export function createVenueRatingSettings(
  doc: Document,
  rpc: Rpc,
  options: {
    compact?: boolean;
    changed?: () => void | Promise<void>;
    pickFile?: () => Promise<string | undefined>;
  } = {},
) {
  const section = node(doc, "section");
  section.className = "confucius-venue-rating-settings";
  if (!options.compact) section.append(node(doc, "h3", text("title")));
  section.append(node(doc, "p", text("help")));
  const controls = node(doc, "div");
  controls.className = "confucius-literature-controls";
  const importButton = createWorkspaceButton(doc, "", text("import"));
  importButton.dataset.action = "import-ratings";
  const catalogs = node(doc, "div");
  catalogs.className = "confucius-venue-rating-catalogs";
  const status = node(doc, "p");
  status.setAttribute("role", "status");
  status.className = "confucius-literature-meta";
  let busy = false;
  const run = async (method: string, params?: Record<string, unknown>) => {
    if (busy) return;
    busy = true;
    section.setAttribute("aria-busy", "true");
    for (const button of section.querySelectorAll("button"))
      button.disabled = true;
    status.textContent = text("loading");
    try {
      const value = (await rpc(method, params)) as VenueRatingCatalogState;
      catalogs.replaceChildren();
      for (const catalog of value.catalogs) {
        const row = node(doc, "div");
        row.className = "confucius-venue-rating-catalog";
        row.dataset.catalogId = catalog.id;
        row.append(
          node(
            doc,
            "span",
            `${systemName(catalog.system)} · ${catalog.year} · ${catalog.entries} ${text("entries")} · ${catalog.source.filename ?? catalog.source.name}`,
          ),
        );
        if (catalog.imported) {
          const remove = createWorkspaceButton(doc, "", text("remove"));
          remove.dataset.action = "remove-ratings";
          remove.title = `${text("remove")} · ${systemName(catalog.system)} ${catalog.year}`;
          remove.addEventListener(
            "click",
            () => void run("literature/ratings/remove", { id: catalog.id }),
          );
          row.append(remove);
        }
        catalogs.append(row);
      }
      status.textContent =
        method === "literature/ratings/list" ? "" : text("saved");
      if (method !== "literature/ratings/list") await options.changed?.();
    } catch (error) {
      status.textContent = String(
        error instanceof Error ? error.message : error,
      );
    } finally {
      busy = false;
      section.removeAttribute("aria-busy");
      for (const button of section.querySelectorAll("button"))
        button.disabled = false;
    }
  };
  importButton.addEventListener("click", async () => {
    if (busy) return;
    // Keep picking separate from importing so cancellation never changes a catalog.
    importButton.disabled = true;
    try {
      const path = await (options.pickFile
        ? options.pickFile()
        : new ztoolkit.FilePicker(
            text("import"),
            "open",
            [["ShowJCR CSV", "*.csv"]],
            "",
            doc.defaultView!,
          ).open());
      if (path) await run("literature/ratings/import", { path });
    } catch (error) {
      status.textContent = String(
        error instanceof Error ? error.message : error,
      );
    } finally {
      importButton.disabled = busy;
    }
  });
  controls.append(importButton);
  section.append(controls, catalogs, status);
  return { node: section, refresh: () => run("literature/ratings/list") };
}
