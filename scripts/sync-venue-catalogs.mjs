import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { format } from "prettier";

// Reviewed snapshot. Advancing this pin requires reviewing the official editions.
const output = resolve(
  import.meta.dirname,
  "../apps/zotero-addon/src/modules/host/data/venueCatalogs.json",
);
const definitions = [
  {
    system: "ccf",
    repository: "haozhou-wong/ccf-recommended-list-2026-markdown",
    commit: "dcf1a02335fb44dcaf785997d5c535ab41628a16",
    file: "data/ccf-2026.json",
    name: "CCF · 7th edition",
    source:
      "https://www.ccf.org.cn/ccf/contentcore/resource/download?ID=112CF3BF7E1140ACEB271ADAED12A67ADFABB8FF099E40C2759502A85C8A281F",
    count: 681,
  },
  {
    system: "core",
    repository: "qirunzeng/VenueRank-Lens",
    commit: "a68b51cbf0eaa2bce03b6a51dfffca239ceba857",
    file: "WebExtension/core_catalog.json",
    name: "ICORE2026",
    count: 825,
  },
];
const catalogs = await Promise.all(
  definitions.map(
    async ({
      system,
      repository,
      commit,
      file,
      name,
      source: officialSource,
      count,
    }) => {
      const snapshotUrl = `https://github.com/${repository}/blob/${commit}/${file}`;
      const response = await fetch(
        `https://raw.githubusercontent.com/${repository}/${commit}/${file}`,
        { signal: AbortSignal.timeout(30000) },
      );
      if (!response.ok)
        throw new Error(`Catalog download failed: ${response.status}`);
      const body = await response.text(),
        raw = JSON.parse(body);
      const rawEntries =
        system === "ccf"
          ? raw.domains.flatMap((domain) =>
              ["journals", "conferences"].flatMap((kind) =>
                Object.entries(domain[kind]).flatMap(([rank, rows]) =>
                  rows.map((row) => ({
                    name: row.full_name,
                    abbreviation: row.abbr,
                    rank,
                    kind: kind === "journals" ? "journal" : "conference",
                    domain: domain.name,
                  })),
                ),
              ),
            )
          : raw.entries;
      if (raw.metadata?.year !== 2026 || rawEntries?.length !== count)
        throw new Error(`Unexpected ${system} edition or count`);
      const source = new URL(officialSource ?? raw.metadata.source);
      if (source.protocol !== "https:" || source.username || source.password)
        throw new Error("Invalid official source URL");
      const entries = rawEntries.map((entry) => {
        if (
          !entry.name ||
          !["journal", "conference"].includes(entry.kind) ||
          !(
            system === "ccf"
              ? ["A", "B", "C"]
              : ["A*", "A", "B", "C", "Australasian B", "Australasian C"]
          ).includes(entry.rank) ||
          (system === "core" && entry.kind !== "conference")
        )
          throw new Error(
            `Malformed ${system} catalog entry: ${JSON.stringify(entry)}`,
          );
        return {
          name: entry.name,
          abbreviation: entry.abbreviation,
          kind: entry.kind,
          rank: entry.rank,
          ...(entry.domain ? { category: entry.domain } : {}),
        };
      });
      return {
        system,
        year: 2026,
        source: { name, url: source.href, snapshotUrl },
        sha256: createHash("sha256").update(body).digest("hex"),
        entries,
      };
    },
  ),
);
// Reviewed main-conference identities have different full titles in the two
// official systems. Exact aliases preserve both ratings without fuzzy matching.
for (const abbreviation of [
  "NeurIPS",
  "AAAI",
  "ACL",
  "EMNLP",
  "ICML",
  "ICLR",
  "CVPR",
  "ICCV",
  "SIGIR",
]) {
  const pair = catalogs.map((catalog) =>
    catalog.entries.filter(
      (entry) =>
        entry.kind === "conference" && entry.abbreviation === abbreviation,
    ),
  );
  if (pair.some((entries) => entries.length !== 1))
    throw new Error(`Ambiguous reviewed conference alias: ${abbreviation}`);
  const entries = pair.flat();
  for (const entry of entries)
    entry.aliases = [
      ...new Set(
        entries
          .map((other) => other.name)
          .filter((name) => name !== entry.name),
      ),
    ];
}
const content = await format(JSON.stringify({ version: 1, catalogs }), {
  parser: "json",
});
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== content)
    throw new Error("Venue catalog snapshot is out of sync");
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content);
}
console.log(
  `Verified pinned CCF2026 (${catalogs[0].entries.length}) and ICORE2026 (${catalogs[1].entries.length}) catalogs`,
);
