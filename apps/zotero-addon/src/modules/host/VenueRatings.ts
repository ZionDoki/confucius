import type {
  LiteratureVenue,
  LiteratureWork,
  VenueRating,
  VenueRatingCategory,
  VenueRatingSystem,
} from "@confucius/protocol";
import snapshot from "./data/venueCatalogs.json";

export interface VenueCatalogEntry {
  name: string;
  abbreviation?: string;
  aliases?: string[];
  kind: "journal" | "conference";
  issns?: string[];
  rank?: string;
  categories?: VenueRatingCategory[];
  category?: string;
  impactFactor?: string;
}
export interface VenueCatalog {
  system: VenueRatingSystem;
  year: number;
  source: VenueRating["source"];
  entries: VenueCatalogEntry[];
}
export const BUILTIN_VENUE_CATALOGS = snapshot.catalogs as VenueCatalog[];
export const MAX_VENUE_CSV_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 60_000;

/** Conservative identity normalization, never substring/fuzzy journal matching. */
export function venueName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
export function venueIssns(value: string): string[] {
  return [
    ...new Set(
      (value.match(/\b\d{4}-?\d{3}[\dXx]\b/g) ?? [])
        .map((issn) => issn.replace(/-/g, "").toUpperCase())
        .map((issn) => `${issn.slice(0, 4)}-${issn.slice(4)}`),
    ),
  ];
}
function names(value: string): string[] {
  // A trailing acronym/old acronym is a catalog alias, not a different conference.
  const withoutAcronym = value.replace(
    /\s*\((?:was\s+)?[A-Z][A-Z\d* /-]{1,18}\)\s*$/g,
    "",
  );
  return [...new Set([venueName(value), venueName(withoutAcronym)])].filter(
    Boolean,
  );
}
type Index = {
  names: Map<string, VenueCatalogEntry[]>;
  abbreviations: Map<string, VenueCatalogEntry[]>;
  issns: Map<string, VenueCatalogEntry[]>;
};
const indexes = new WeakMap<VenueCatalog, Index>();
function index(catalog: VenueCatalog): Index {
  const existing = indexes.get(catalog);
  if (existing) return existing;
  const value: Index = {
    names: new Map(),
    abbreviations: new Map(),
    issns: new Map(),
  };
  const add = (
    map: Map<string, VenueCatalogEntry[]>,
    key: string,
    entry: VenueCatalogEntry,
  ) => {
    const entries = map.get(key) ?? [];
    if (!entries.includes(entry)) entries.push(entry);
    map.set(key, entries);
  };
  for (const entry of catalog.entries) {
    for (const name of [entry.name, ...(entry.aliases ?? [])].flatMap(names))
      add(value.names, name, entry);
    if (entry.abbreviation)
      add(value.abbreviations, venueName(entry.abbreviation), entry);
    for (const issn of entry.issns ?? []) add(value.issns, issn, entry);
  }
  indexes.set(catalog, value);
  return value;
}
function publications(work: LiteratureWork): LiteratureVenue[] {
  const venues = work.venues?.filter((v) => v.type !== "repository" && v.name);
  // An explicit repository is not a publication venue, including old venue text.
  if (work.venues?.length) return venues ?? [];
  return work.venue ? [{ name: work.venue, issns: [] }] : [];
}
function outsideConferenceScope(
  venue: LiteratureVenue,
  entry: VenueCatalogEntry,
): boolean {
  const name = `${venue.name} ${venue.rawName ?? ""}`;
  if (
    /\b(findings|companion|short papers?|demo(?:nstration)?s?(?: papers?)?|technical briefs?|summaries)\b/i.test(
      name,
    )
  )
    return true;
  // A separately ranked workshop (e.g. HotNets) is valid; companion workshops are not.
  return (
    /\bworkshops?\b/i.test(name) &&
    !(
      /\bworkshops?\b/i.test(entry.name) &&
      names(venue.name).some((n) => names(entry.name).includes(n)) &&
      (!venue.rawName ||
        names(venue.rawName).some((n) => names(entry.name).includes(n)))
    )
  );
}
export function matchVenueRatings(
  work: LiteratureWork,
  catalogs: readonly VenueCatalog[] = BUILTIN_VENUE_CATALOGS,
): VenueRating[] {
  if (["preprint", "posted-content"].includes(work.publicationType ?? ""))
    return [];
  const ratings: VenueRating[] = [];
  for (const catalog of catalogs) {
    const lookup = index(catalog);
    const matches = new Map<VenueCatalogEntry, VenueRating["matchedBy"]>();
    for (const venue of publications(work)) {
      const issns = [...new Set(venue.issns.flatMap(venueIssns))];
      let found = [
        ...new Set(issns.flatMap((issn) => lookup.issns.get(issn) ?? [])),
      ];
      let matchedBy: VenueRating["matchedBy"] = "issn";
      if (!found.length) {
        const identities = [
          venue.name,
          ...(["book series", "ebook platform"].includes(venue.type ?? "") &&
          venue.rawName
            ? [venue.rawName]
            : []),
        ];
        found = [
          ...new Set(
            identities.flatMap((identity) =>
              names(identity).flatMap((name) => lookup.names.get(name) ?? []),
            ),
          ),
        ];
        matchedBy = "name";
        if (!found.length && venue.type !== "journal") {
          // OpenAlex names some main conferences "Proceedings of the <title>".
          // Strip only this anchored publication prefix, then require a complete
          // catalog conference title; original track names still govern scope.
          found = [
            ...new Set(
              identities.flatMap((identity) =>
                names(
                  identity.replace(/^proceedings of(?: the)?\s+/i, ""),
                ).flatMap((name) => lookup.names.get(name) ?? []),
              ),
            ),
          ].filter((entry) => entry.kind === "conference");
        }
        if (!found.length) {
          found = [
            ...new Set(
              identities.flatMap(
                (identity) =>
                  lookup.abbreviations.get(venueName(identity)) ?? [],
              ),
            ),
          ];
          matchedBy = "abbreviation";
        }
        // A title must not overrule conflicting ISSNs (including homonymous journals).
        found = found.filter(
          (entry) =>
            !issns.length ||
            !entry.issns?.length ||
            entry.issns.some((s) => issns.includes(s)),
        );
      }
      found = found.filter(
        (entry) =>
          (venue.type !== "journal" || entry.kind === "journal") &&
          (venue.type !== "conference" || entry.kind === "conference") &&
          !(
            ["book series", "ebook platform"].includes(venue.type ?? "") &&
            !venue.rawName
          ) &&
          (entry.kind !== "conference" ||
            !outsideConferenceScope(venue, entry)),
      );
      // Acronyms/title collisions never choose an arbitrary venue or the best grade.
      if (new Set(found.map((entry) => venueName(entry.name))).size !== 1)
        continue;
      if (
        new Set(found.flatMap((entry) => entry.issns?.join("|") ?? [])).size > 1
      )
        continue;
      for (const entry of found) matches.set(entry, matchedBy);
    }
    if (!matches.size) continue;
    const entries = [...matches.keys()];
    // Different publication venues in a record must not collapse into a single rank.
    if (new Set(entries.map((entry) => venueName(entry.name))).size !== 1)
      continue;
    const categories = entries.flatMap(
      (entry) =>
        entry.categories ??
        (entry.category
          ? [
              {
                name: entry.category,
                rank: entry.rank,
                scope: "subject" as const,
              },
            ]
          : []),
    );
    const ranks = [
      ...new Set(entries.flatMap((entry) => (entry.rank ? [entry.rank] : []))),
    ];
    ratings.push({
      system: catalog.system,
      year: catalog.year,
      rank: ranks.length ? ranks.join(" / ") : undefined,
      categories: [
        ...new Map(categories.map((c) => [JSON.stringify(c), c])).values(),
      ],
      impactFactor: entries[0].impactFactor,
      source: { ...catalog.source },
      matchedBy: [...matches.values()].includes("issn")
        ? "issn"
        : [...matches.values()][0],
    });
  }
  return ratings;
}

/** RFC 4180-style CSV: BOM, CRLF, quoted commas/newlines and escaped quotes. */
export function venueCsvRows(text: string): string[][] {
  if (text.length > MAX_VENUE_CSV_BYTES)
    throw new Error("CSV exceeds 32 MiB / CSV 超过 32 MiB");
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const field = () => {
    row.push(cell.trim());
    cell = "";
    closed = false;
    if (row.length > 160)
      throw new Error("Too many CSV columns / CSV 列数过多");
  };
  const line = () => {
    field();
    if (row.some(Boolean)) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1)
      throw new Error("Too many CSV rows / CSV 行数过多");
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === ",") field();
    else if (char === "\n" || char === "\r") {
      line();
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (char === '"') {
      if (cell || closed)
        throw new Error("Invalid CSV quoting / CSV 引号格式错误");
      quoted = true;
    } else if (closed && !/\s/.test(char))
      throw new Error("Invalid CSV quoting / CSV 引号格式错误");
    else if (!closed) cell += char;
    if (cell.length > 16_384)
      throw new Error("CSV field too long / CSV 字段过长");
  }
  if (quoted) throw new Error("Unclosed CSV quote / CSV 引号未闭合");
  if (cell || row.length || closed) line();
  return rows;
}
function partition(value: string): { rank?: string; position?: string } {
  if (!value || /^(?:—|-|N\/?A|未分区)$/i.test(value)) return {};
  const match = value.match(/^([1-4])\s*(?:区)?\s*(?:\[([^\]]+)\])?$/);
  if (!match) throw new Error(`Invalid partition: ${value} / 无效分区`);
  return { rank: match[1], ...(match[2] ? { position: match[2] } : {}) };
}
const yes = (value: string) => /^(?:是|yes|true|1|top)$/i.test(value);
export function parseShowJcrCsv(
  text: string,
  filename: string,
  importedAt = Date.now(),
): VenueCatalog {
  const [header, ...rows] = venueCsvRows(text);
  if (!header || !rows.length)
    throw new Error("Empty ShowJCR CSV / ShowJCR CSV 没有数据");
  if (new Set(header).size !== header.length || !header.includes("Journal"))
    throw new Error("Invalid ShowJCR header / ShowJCR 表头无效");
  const system = header.includes("大类新锐分区")
    ? "xr"
    : header.includes("大类分区")
      ? "cas"
      : header.some((h) => /^IF Quartile\(\d{4}\)_\d+$/.test(h))
        ? "jcr"
        : undefined;
  if (!system)
    throw new Error("Unsupported ShowJCR CSV / 不支持的 ShowJCR CSV 类型");
  filename = filename.split(/[\\/]/).at(-1)!.slice(0, 240);
  const file = filename.match(/^(JCR|FQBJCR|XR)(\d{4})(?:-UTF8)?\.csv$/i);
  const fileSystem = file
    ? ({ jcr: "jcr", fqbjcr: "cas", xr: "xr" } as const)[
        file[1].toLowerCase() as "jcr" | "fqbjcr" | "xr"
      ]
    : undefined;
  if (fileSystem && fileSystem !== system)
    throw new Error(
      "CSV filename and columns disagree / CSV 文件名与表头类型不一致",
    );
  const indicatorYears = new Set(
    header.flatMap((h) => {
      const m = h.match(/^(?:IF|IF Quartile|IF Rank)\((\d{4})\)(?:_\d+)?$/);
      return m ? [Number(m[1])] : [];
    }),
  );
  const years = new Set<number>([
    ...indicatorYears,
    ...(file ? [Number(file[2])] : []),
  ]);
  const at = (row: string[], name: string) => row[header.indexOf(name)] ?? "";
  if (system !== "jcr")
    for (const row of rows) {
      const year = at(row, "年份");
      if (year) {
        if (!/^\d{4}$/.test(year))
          throw new Error("Invalid CSV year / CSV 年份无效");
        years.add(Number(year));
      }
    }
  if (years.size !== 1)
    throw new Error(
      "CSV must identify one consistent year / CSV 必须有明确且一致的年份",
    );
  const year = [...years][0];
  if (year < 2000 || year > 2100 || (system === "cas" && year > 2025))
    throw new Error(
      "Unsupported catalog year / 不支持的目录年份（中科院分区止于 2025 年）",
    );
  const requireColumn = (name: string) => {
    if (!header.includes(name))
      throw new Error(`Missing ShowJCR column: ${name} / ShowJCR 缺少必要列`);
  };
  if (system === "jcr") {
    requireColumn(`IF(${year})`);
    requireColumn("Category_1");
    for (const h of header) {
      const category = h.match(/^Category_(\d+)$/),
        quartile = h.match(/^IF Quartile\(\d{4}\)_(\d+)$/);
      if (category) requireColumn(`IF Quartile(${year})_${category[1]}`);
      if (quartile) requireColumn(`Category_${quartile[1]}`);
    }
  } else if (system === "cas") {
    requireColumn("大类");
    for (const h of header) {
      const category = h.match(/^小类(\d+)$/),
        quartile = h.match(/^小类(\d+)分区$/);
      if (category) requireColumn(`小类${category[1]}分区`);
      if (quartile) requireColumn(`小类${quartile[1]}`);
    }
  } else {
    if (!header.includes("大类中文名") && !header.includes("大类英文名"))
      requireColumn("大类中文名");
    for (const h of header) {
      const category = h.match(/^((?:大类2?|小类\d+))(?:中|英)文名$/);
      if (category) requireColumn(`${category[1]}新锐分区`);
    }
  }
  const entries: VenueCatalogEntry[] = [];
  for (const [i, row] of rows.entries()) {
    if (row.length !== header.length)
      throw new Error(`CSV column count at row ${i + 2} / CSV 行列数不一致`);
    const name = at(row, "Journal");
    if (!name)
      throw new Error(`Missing journal at row ${i + 2} / CSV 缺少期刊名称`);
    const categories: VenueRatingCategory[] = [];
    let impactFactor: string | undefined;
    if (system === "jcr") {
      impactFactor = at(row, `IF(${year})`) || undefined;
      if (
        impactFactor &&
        !/^(?:\d+(?:\.\d+)?|<\s*\d+(?:\.\d+)?|N\/?A|—|-)$/i.test(impactFactor)
      )
        throw new Error(
          `Invalid impact factor at row ${i + 2} / 影响因子格式无效`,
        );
      for (const h of header.filter((h) => /^Category_\d+$/.test(h))) {
        const suffix = h.slice("Category_".length),
          subject = at(row, h),
          rank = at(row, `IF Quartile(${year})_${suffix}`);
        if (rank && !/^(?:Q[1-4]|N\/?A|—|-)$/i.test(rank))
          throw new Error(
            `Invalid JCR quartile at row ${i + 2} / JCR 分区无效`,
          );
        if (subject)
          categories.push({
            name: subject,
            rank: /^Q[1-4]$/i.test(rank) ? rank.toUpperCase() : undefined,
            scope: "subject",
            position: at(row, `IF Rank(${year})_${suffix}`) || undefined,
          });
      }
    } else {
      for (const major of ["", "2"]) {
        const name =
          system === "cas"
            ? at(row, "大类")
            : at(row, `大类${major}中文名`) || at(row, `大类${major}英文名`);
        const value = at(
          row,
          system === "cas" ? "大类分区" : `大类${major}新锐分区`,
        );
        if (name)
          categories.push({
            name,
            ...partition(value),
            scope: "major",
            top: yes(
              at(row, `大类${major}Top`) || (!major ? at(row, "Top") : ""),
            ),
          });
        if (system === "cas") break;
      }
      for (let number = 1; number <= 12; number++) {
        const name =
          system === "cas"
            ? at(row, `小类${number}`)
            : at(row, `小类${number}中文名`) || at(row, `小类${number}英文名`);
        if (name)
          categories.push({
            name,
            ...partition(
              at(
                row,
                system === "cas"
                  ? `小类${number}分区`
                  : `小类${number}新锐分区`,
              ),
            ),
            scope: "minor",
          });
      }
    }
    const ranks = [
      ...new Set(
        categories
          .filter((c) => system === "jcr" || c.scope === "major")
          .flatMap((c) => (c.rank ? [c.rank] : [])),
      ),
    ];
    const issns = venueIssns(
      [at(row, "ISSN"), at(row, "EISSN"), at(row, "ISSN/EISSN")].join(" "),
    );
    entries.push({
      name,
      kind: "journal",
      issns,
      rank: ranks.length ? ranks.join(" / ") : undefined,
      categories,
      impactFactor,
    });
  }
  return {
    system,
    year,
    entries,
    source: {
      name: "ShowJCR CSV",
      url: "https://github.com/hitfyd/ShowJCR",
      filename,
      importedAt,
    },
  };
}
