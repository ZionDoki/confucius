import type {
  LiteratureWork,
  VenueRatingCatalogState,
  VenueRatingCatalogSummary,
} from "@confucius/protocol";
import {
  ResourceLocks,
  runtimeJsonStorage,
  runtimeIoPath,
  type JsonStorage,
} from "./RuntimeStorage";
import {
  BUILTIN_VENUE_CATALOGS,
  MAX_VENUE_CSV_BYTES,
  matchVenueRatings,
  parseShowJcrCsv,
  type VenueCatalog,
} from "./VenueRatings";

interface StoredCatalogs {
  version: 1;
  catalogs: VenueCatalog[];
}
const key = (catalog: Pick<VenueCatalog, "system" | "year">) =>
  `${catalog.system}_${catalog.year}`;
function validImportedCatalog(catalog: VenueCatalog): boolean {
  return (
    !!catalog &&
    ["jcr", "cas", "xr"].includes(catalog.system) &&
    Number.isInteger(catalog.year) &&
    catalog.year >= 2000 &&
    catalog.year <= 2100 &&
    (catalog.system !== "cas" || catalog.year <= 2025) &&
    typeof catalog.source?.filename === "string" &&
    !!catalog.source.filename &&
    catalog.source.name === "ShowJCR CSV" &&
    catalog.source.url === "https://github.com/hitfyd/ShowJCR" &&
    Array.isArray(catalog.entries) &&
    catalog.entries.length > 0 &&
    catalog.entries.length <= 60_000 &&
    catalog.entries.every(
      (entry) =>
        !!entry &&
        typeof entry.name === "string" &&
        !!entry.name &&
        entry.kind === "journal" &&
        Array.isArray(entry.issns) &&
        entry.issns.every(
          (issn) => typeof issn === "string" && /^\d{4}-\d{3}[\dX]$/.test(issn),
        ) &&
        (entry.rank === undefined || typeof entry.rank === "string") &&
        (entry.impactFactor === undefined ||
          typeof entry.impactFactor === "string") &&
        Array.isArray(entry.categories) &&
        entry.categories.every(
          (category) =>
            !!category &&
            typeof category.name === "string" &&
            ["subject", "major", "minor"].includes(category.scope) &&
            (category.rank === undefined || typeof category.rank === "string"),
        ),
    )
  );
}
export class VenueRatingStore {
  private readonly lock = new ResourceLocks();
  private saved?: Promise<StoredCatalogs>;
  constructor(
    private readonly storage: JsonStorage = runtimeJsonStorage("venue-ratings"),
  ) {}
  private load(): Promise<StoredCatalogs> {
    if (!this.saved)
      this.saved = this.storage
        .read<StoredCatalogs>("catalogs")
        .then((saved) => {
          if (!saved) return { version: 1 as const, catalogs: [] };
          if (
            saved.version !== 1 ||
            !Array.isArray(saved.catalogs) ||
            saved.catalogs.some((c) => !validImportedCatalog(c)) ||
            new Set(saved.catalogs.map(key)).size !== saved.catalogs.length
          )
            throw new Error(
              "Imported venue catalogs are damaged / 导入的评级目录已损坏",
            );
          return saved;
        })
        .catch((error) => {
          this.saved = undefined;
          throw error;
        });
    return this.saved;
  }
  async list(): Promise<VenueRatingCatalogState> {
    const saved = await this.load();
    const summarize = (
      catalog: VenueCatalog,
      imported: boolean,
    ): VenueRatingCatalogSummary => ({
      id: key(catalog),
      system: catalog.system,
      year: catalog.year,
      entries: catalog.entries.length,
      source: { ...catalog.source },
      imported,
    });
    return {
      catalogs: [
        ...BUILTIN_VENUE_CATALOGS.map((c) => summarize(c, false)),
        ...saved.catalogs.map((c) => summarize(c, true)),
      ],
    };
  }
  async importCsv(
    text: string,
    filename: string,
  ): Promise<VenueRatingCatalogState> {
    const catalog = parseShowJcrCsv(text, filename);
    await this.lock.run(["catalogs"], async () => {
      const previous = await this.load();
      const saved: StoredCatalogs = {
        version: 1,
        catalogs: [
          ...previous.catalogs.filter((c) => key(c) !== key(catalog)),
          catalog,
        ],
      };
      // A failed atomic save leaves both the old file and the live index unchanged.
      await this.storage.write("catalogs", saved);
      this.saved = Promise.resolve(saved);
    });
    return this.list();
  }
  async importFile(path: string): Promise<VenueRatingCatalogState> {
    if (!/\.csv$/i.test(path))
      throw new Error("Select a CSV file / 请选择 CSV 文件");
    const stat = await IOUtils.stat(runtimeIoPath(path));
    if (
      stat.type !== "regular" ||
      stat.size === undefined ||
      stat.size > MAX_VENUE_CSV_BYTES
    )
      throw new Error(
        "CSV must be a regular file of at most 32 MiB / CSV 必须是最多 32 MiB 的普通文件",
      );
    const bytes = await IOUtils.read(runtimeIoPath(path), {
      maxBytes: MAX_VENUE_CSV_BYTES + 1,
    });
    if (bytes.length > MAX_VENUE_CSV_BYTES)
      throw new Error("CSV exceeds 32 MiB / CSV 超过 32 MiB");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        "Use a UTF-8 ShowJCR CSV / 请使用 UTF-8 编码的 ShowJCR CSV",
      );
    }
    return this.importCsv(text, PathUtils.filename(path));
  }
  async remove(id: string): Promise<VenueRatingCatalogState> {
    if (!/^(jcr|cas|xr)_\d{4}$/.test(id))
      throw new Error(
        "Only imported catalogs can be removed / 只能移除导入的目录",
      );
    await this.lock.run(["catalogs"], async () => {
      const previous = await this.load();
      const saved: StoredCatalogs = {
        version: 1,
        catalogs: previous.catalogs.filter((c) => key(c) !== id),
      };
      await this.storage.write("catalogs", saved);
      this.saved = Promise.resolve(saved);
    });
    return this.list();
  }
  async enrich(works: LiteratureWork[]): Promise<LiteratureWork[]> {
    let imported: VenueCatalog[] = [],
      unavailable = false;
    try {
      imported = (await this.load()).catalogs;
    } catch {
      unavailable = true;
    }
    // Show the newest imported edition of each system, retaining older imports for history.
    const latest = new Map<string, VenueCatalog>();
    for (const catalog of imported)
      if (
        !latest.has(catalog.system) ||
        latest.get(catalog.system)!.year < catalog.year
      )
        latest.set(catalog.system, catalog);
    const catalogs = [...BUILTIN_VENUE_CATALOGS, ...latest.values()];
    return works.map((work) => {
      const venueRatings = matchVenueRatings(work, catalogs);
      return {
        ...work,
        venueRatings,
        venueRatingStatus: unavailable
          ? "unavailable"
          : venueRatings.length
            ? "matched"
            : "unmatched",
      };
    });
  }
}
