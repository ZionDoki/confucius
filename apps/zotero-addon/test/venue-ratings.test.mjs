import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILTIN_VENUE_CATALOGS,
  matchVenueRatings,
  parseShowJcrCsv,
  venueCsvRows,
  venueIssns,
} from "../src/modules/host/VenueRatings.ts";
import { VenueRatingStore } from "../src/modules/host/VenueRatingStore.ts";
import { memoryJsonStorage } from "../src/modules/host/RuntimeStorage.ts";
import { ReviewModel } from "../src/modules/ui/reviewModel.ts";
import { LiteratureService } from "../src/modules/host/LiteratureService.ts";
import {
  OpenAlexClient,
  openAlexWork,
} from "../src/modules/host/OpenAlexClient.ts";
import {
  csv,
  jcrCsv,
  casCsv,
  xrCsv,
  journalName,
} from "../../../scripts/fixtures/venue-ratings.mjs";

const work = (name = journalName, extra = {}) =>
  openAlexWork(
    {
      id: "https://openalex.org/W100",
      title: "A research paper",
      type: "article",
      publication_year: 2021,
      primary_location: {
        source: {
          id: "https://openalex.org/S100",
          display_name: name,
          type: "journal",
          issn_l: "0734-2071",
          issn: ["0734-2071", "1557-7333"],
        },
      },
      ...extra,
    },
    "query",
  );
const conference = (name, extra = {}) =>
  work(name, {
    primary_location: {
      source: { display_name: name, type: "conference" },
      ...extra,
    },
  });

test("projected rating changes refresh an equal revision without dropping review state or replaying arrivals", () => {
  const model = new ReviewModel("task", {
    defaultStatus: "all",
    completion: false,
  });
  const batch = {
    id: "query",
    title: "Search",
    createdAt: 1,
    entries: [{ id: "paper", quote: "Paper", comment: "", status: "pending" }],
  };
  model.update({
    taskId: "task",
    revision: 2,
    batches: [batch],
    metadataKey: "before-import",
  });
  assert.equal(model.arrivedEntries(["paper"]), "open");
  model.presentation = "list";
  model.view.query = "Paper";
  model.view.scroll = 120;
  model.view.current = model.rows()[0].key;
  model.view.selected.add(model.rows()[0].key);
  const before = model.view;
  assert.equal(
    model.update({
      taskId: "task",
      revision: 2,
      batches: [batch],
      metadataKey: "after-import",
    }),
    true,
  );
  assert.equal(model.view, before);
  assert.equal(model.view.scroll, 120);
  assert.equal(model.view.selected.size, 1);
  assert.equal(model.presentation, "list");
  assert.equal(model.arrivedEntries(["paper"]), undefined);
  assert.equal(
    model.update({
      taskId: "task",
      revision: 2,
      batches: [batch],
      metadataKey: "after-import",
    }),
    false,
  );
  assert.equal(
    model.update({
      taskId: "task",
      revision: 1,
      batches: [batch],
      metadataKey: "old-response",
    }),
    false,
  );
  const annotations = new ReviewModel("task");
  annotations.update({ taskId: "task", revision: 2, batches: [batch] });
  assert.equal(
    annotations.update({ taskId: "task", revision: 2, batches: [batch] }),
    false,
  );
});

test("pinned editions retain official sources and common journal/conference ratings", () => {
  assert.deepEqual(
    BUILTIN_VENUE_CATALOGS.map((c) => [c.system, c.year, c.entries.length]),
    [
      ["ccf", 2026, 681],
      ["core", 2026, 825],
    ],
  );
  const journal = matchVenueRatings(work());
  assert.deepEqual(
    journal.map((r) => [r.system, r.year, r.rank]),
    [["ccf", 2026, "A"]],
  );
  assert.match(journal[0].source.url, /^https:\/\/www.ccf.org.cn/);
  assert.match(
    journal[0].source.snapshotUrl,
    /dcf1a02335fb44dcaf785997d5c535ab41628a16/,
  );
  for (const name of [
    "NeurIPS",
    "Advances in Neural Information Processing Systems",
    "Conference on Neural Information Processing Systems",
    "AAAI Conference on Artificial Intelligence",
    "Proceedings of the AAAI Conference on Artificial Intelligence",
  ]) {
    assert.deepEqual(
      matchVenueRatings(conference(name)).map((r) => [r.system, r.rank]),
      [
        ["ccf", "A"],
        ["core", "A*"],
      ],
      name,
    );
  }
});
test("exact names handle punctuation and case; uncertain identities remain unmatched", () => {
  assert.equal(
    matchVenueRatings(work("ACM TRANSACTIONS ON COMPUTER SYSTEMS"))[0].rank,
    "A",
  );
  assert.deepEqual(matchVenueRatings(work("Computer Systems")), []);
  assert.deepEqual(matchVenueRatings(work("Unknown journal")), []);
  assert.deepEqual(matchVenueRatings(conference("NeurIPS Workshop")), []);
  assert.deepEqual(
    matchVenueRatings(conference("Proceedings of the NeurIPS Workshop")),
    [],
  );
  assert.deepEqual(
    matchVenueRatings(
      conference("NeurIPS", { raw_source_name: "NeurIPS Workshop on X" }),
    ),
    [],
  );
  assert.deepEqual(
    matchVenueRatings(
      conference("ACL", { raw_source_name: "Findings of ACL" }),
    ),
    [],
  );
  assert.deepEqual(
    matchVenueRatings(
      conference("AAAI", {
        raw_source_name: "AAAI Companion: Demonstration Papers",
      }),
    ),
    [],
  );
});
test("demo tracks and malformed source names cannot borrow ratings or break matching", () => {
  assert.deepEqual(
    matchVenueRatings(
      conference("AAAI", { raw_source_name: "AAAI Demo Track" }),
    ),
    [],
  );
  assert.deepEqual(
    matchVenueRatings(
      work("ignored", { primary_location: { source: { display_name: 42 } } }),
    ),
    [],
  );
});
test("repositories, preprints, source-kind conflicts and unidentified proceedings do not borrow ratings", () => {
  for (const publicationType of ["preprint", "posted-content"])
    assert.deepEqual(matchVenueRatings({ ...work(), publicationType }), []);
  assert.deepEqual(
    matchVenueRatings({
      ...work(),
      venues: [{ name: journalName, type: "repository", issns: [] }],
    }),
    [],
  );
  assert.deepEqual(
    matchVenueRatings({
      ...work(),
      venues: [{ name: "ICML", type: "journal", issns: [] }],
    }),
    [],
  );
  const series = {
    ...work(),
    venues: [
      {
        name: "Proceedings of Machine Learning Research",
        type: "book series",
        issns: [],
      },
    ],
  };
  assert.deepEqual(matchVenueRatings(series), []);
  series.venues[0].rawName = "ICML";
  assert.deepEqual(
    matchVenueRatings(series).map((r) => r.system),
    ["ccf", "core"],
  );
});
test("independently ranked workshops keep their own rank", () => {
  const hotnets = matchVenueRatings(
    conference("ACM The Workshop on Hot Topics in Networks"),
  );
  assert.equal(hotnets.find((r) => r.system === "ccf")?.rank, "C");
});
test("OpenAlex preserves source identities, ISSNs and original track names", () => {
  const value = work("Renamed journal", {
    locations: [
      {
        source: { display_name: "arXiv", type: "repository" },
        raw_source_name: "arXiv",
      },
    ],
  });
  assert.equal(value.publicationType, "article");
  assert.deepEqual(value.venues[0].issns, ["0734-2071", "1557-7333"]);
  assert.equal(value.venues[0].id, "https://openalex.org/S100");
  assert.equal(value.venues[1].type, "repository");
  assert.equal(value.venues[1].rawName, "arXiv");
  assert.deepEqual(venueIssns("1234567x/1234-567X; 0734-2071"), [
    "1234-567X",
    "0734-2071",
  ]);
});
test("JCR preserves all quartiles, factor, position and import provenance", () => {
  const catalog = parseShowJcrCsv(
    "\uFEFF" + jcrCsv(),
    "/private/JCR2025-UTF8.csv",
    123,
  );
  assert.equal(catalog.system, "jcr");
  assert.equal(catalog.year, 2025);
  assert.equal(catalog.source.filename, "JCR2025-UTF8.csv");
  assert.equal(catalog.source.importedAt, 123);
  const rating = matchVenueRatings(work("Renamed journal"), [catalog])[0];
  assert.equal(rating.matchedBy, "issn");
  assert.equal(rating.rank, "Q1 / Q2");
  assert.equal(rating.impactFactor, "2.1");
  assert.deepEqual(
    rating.categories.map((c) => [c.rank, c.position]),
    [
      ["Q1", "1/100"],
      ["Q2", "21/100"],
    ],
  );
});
test("CAS and Xinrui remain separate systems, with major/minor categories and Top", () => {
  const cas = parseShowJcrCsv(casCsv(), "FQBJCR2025-UTF8.csv");
  const xr = parseShowJcrCsv(xrCsv(), "XR2026-UTF8.csv");
  assert.equal(cas.entries[0].rank, "2");
  assert.equal(cas.entries[0].categories[0].position, "25/100");
  assert.equal(cas.entries[0].categories[0].top, true);
  assert.equal(
    cas.entries[0].categories.filter((c) => c.scope === "minor").length,
    2,
  );
  assert.equal(xr.system, "xr");
  assert.equal(xr.entries[0].rank, "1 / 2");
  assert.deepEqual(
    xr.entries[0].categories.map((c) => [c.scope, c.rank]),
    [
      ["major", "1"],
      ["major", "2"],
      ["minor", "2"],
      ["minor", "3"],
    ],
  );
});
test("CSV quoting, UTF-8 BOM, CRLF, blank lines, escaped quotes and multiline subjects", () => {
  const source = jcrCsv(2025, 'Journal, "Name"\nSecond line');
  const catalog = parseShowJcrCsv(
    "\uFEFF" + source + "\r\n\r\n",
    "renamed.csv",
  );
  assert.equal(catalog.entries[0].name, 'Journal, "Name"\nSecond line');
  assert.equal(venueCsvRows('a,b\r\n"x,y","z""q"')[1][1], 'z"q');
});
test("conflicting/missing years, malformed columns, invalid quartiles and CAS 2026 reject the whole import", () => {
  for (const [source, name] of [
    [jcrCsv(), "JCR2024.csv"],
    [jcrCsv(), "XR2025.csv"],
    [casCsv(2026), "FQBJCR2026.csv"],
    [casCsv().replaceAll('"2025"', '""'), "renamed.csv"],
    [jcrCsv(2025, journalName, "Q5"), "JCR2025.csv"],
    [jcrCsv().replace('"Category_2",', ""), "JCR2025.csv"],
    [jcrCsv() + "\nwrong,columns", "JCR2025.csv"],
    ["Journal,大类分区\nTest,1", "FQBJCR2025.csv"],
  ])
    assert.throws(() => parseShowJcrCsv(source, name), undefined, name);
  for (const invalid of ['a,b\n"open,x', 'a,b\n"closed"x,y', 'a,b\nx"y,z'])
    assert.throws(() => venueCsvRows(invalid));
});
test("ISSNs prevent homonymous title misidentification and conflicting identifiers block title fallback", () => {
  const catalog = parseShowJcrCsv(
    csv([
      ["Journal", "ISSN", "IF(2025)", "Category_1", "IF Quartile(2025)_1"],
      ["Shared title", "1111-1111", "1", "Physics", "Q1"],
      ["Shared title", "2222-2222", "1", "Physics", "Q3"],
    ]),
    "JCR2025.csv",
  );
  const paper = {
    ...work(),
    venues: [{ name: "Shared title", type: "journal", issns: [] }],
  };
  assert.deepEqual(matchVenueRatings(paper, [catalog]), []);
  paper.venues[0].issns = ["2222-2222"];
  assert.equal(matchVenueRatings(paper, [catalog])[0].rank, "Q3");
  paper.venues[0].issns = ["3333-3333"];
  assert.deepEqual(matchVenueRatings(paper, [catalog]), []);
});
test("ambiguous acronyms never choose a better-ranked venue", () => {
  const catalog = {
    system: "core",
    year: 2026,
    source: { name: "Test", url: "https://example.org" },
    entries: [
      {
        name: "First Conference",
        abbreviation: "ABC",
        kind: "conference",
        rank: "A*",
      },
      {
        name: "Second Conference",
        abbreviation: "ABC",
        kind: "conference",
        rank: "C",
      },
    ],
  };
  assert.deepEqual(matchVenueRatings(conference("ABC"), [catalog]), []);
});
test("imports persist, replace same edition, show the latest year and fall back on removal", async () => {
  const storage = memoryJsonStorage(),
    store = new VenueRatingStore(storage);
  await Promise.all([
    store.importCsv(jcrCsv(2024), "JCR2024.csv"),
    store.importCsv(casCsv(), "FQBJCR2025.csv"),
  ]);
  await store.importCsv(jcrCsv(), "JCR2025.csv");
  await store.importCsv(jcrCsv(2025, journalName, "Q3"), "JCR2025-UTF8.csv");
  const list = await store.list();
  assert.equal(list.catalogs.filter((c) => c.system === "jcr").length, 2);
  assert.equal(
    list.catalogs.find((c) => c.id === "jcr_2025").source.filename,
    "JCR2025-UTF8.csv",
  );
  const resumed = new VenueRatingStore(storage);
  let rating = (await resumed.enrich([work()]))[0].venueRatings.find(
    (r) => r.system === "jcr",
  );
  assert.equal(rating.year, 2025);
  assert.equal(rating.rank, "Q3 / Q2");
  await resumed.remove("jcr_2025");
  rating = (await resumed.enrich([work()]))[0].venueRatings.find(
    (r) => r.system === "jcr",
  );
  assert.equal(rating.year, 2024);
  await assert.rejects(resumed.remove("ccf_2026"), /Only imported/);
});
test("invalid import and failed atomic save preserve the previous live and persisted catalog", async () => {
  const backing = memoryJsonStorage();
  let fail = false;
  const store = new VenueRatingStore({
    ...backing,
    write: async (...args) => {
      if (fail) throw new Error("disk full");
      return backing.write(...args);
    },
  });
  await store.importCsv(jcrCsv(), "JCR2025.csv");
  await assert.rejects(
    store.importCsv(jcrCsv(2025, journalName, "Q5"), "JCR2025.csv"),
  );
  fail = true;
  await assert.rejects(
    store.importCsv(jcrCsv(2025, journalName, "Q3"), "JCR2025.csv"),
    /disk full/,
  );
  for (const instance of [store, new VenueRatingStore(backing)])
    assert.equal(
      (await instance.enrich([work()]))[0].venueRatings.find(
        (r) => r.system === "jcr",
      ).rank,
      "Q1 / Q2",
    );
});
test("damaged imported data leaves literature usable with built-in ratings and explicit unavailable status", async () => {
  const storage = memoryJsonStorage();
  await storage.write("catalogs", {
    version: 1,
    catalogs: [
      {
        system: "jcr",
        year: 2025,
        source: { filename: "JCR2025.csv" },
        entries: [null],
      },
    ],
  });
  const store = new VenueRatingStore(storage);
  await assert.rejects(store.list(), /damaged/);
  const [paper] = await store.enrich([work()]);
  assert.equal(paper.venueRatingStatus, "unavailable");
  assert.equal(paper.venueRatings[0].system, "ccf");
});
test("import refresh updates existing list/get/review without candidate revisions, decisions or library writes", async () => {
  const ratings = new VenueRatingStore(memoryJsonStorage()),
    storage = memoryJsonStorage();
  const service = new LiteratureService({
    storage,
    ratings,
    exists: () => true,
    changed: async () => {},
    client: new OpenAlexClient(
      () => "",
      async () => ({
        status: 200,
        data: {
          results: [
            {
              id: "https://openalex.org/W100",
              title: "Test paper",
              primary_location: {
                source: {
                  display_name: journalName,
                  type: "journal",
                  issn: ["0734-2071"],
                },
              },
            },
          ],
          meta: { count: 1, next_cursor: null },
        },
      }),
    ),
    canConfirm: () => {
      throw new Error("No confirmation allowed");
    },
    bind: async () => {
      throw new Error("No binding allowed");
    },
    acquire: {
      ensureItem: async () => {
        throw new Error("No import allowed");
      },
    },
  });
  await service.search("task", { query: "Test" });
  await service.updateCandidates(
    "task",
    0,
    [{ id: "W100", selected: true, reason: "User choice" }],
    "user",
  );
  const before = await service.review("task");
  await ratings.importCsv(jcrCsv(), "JCR2025.csv");
  const after = await service.review("task");
  assert.deepEqual(after.summary, before.summary);
  assert.deepEqual(after.items[0].decision, before.items[0].decision);
  assert.deepEqual(
    after.items[0].venueRatings.map((r) => r.system),
    ["ccf", "jcr"],
  );
  assert.deepEqual(
    (await service.list("task")).items[0].venueRatings,
    after.items[0].venueRatings,
  );
  assert.deepEqual(
    (await service.get("task", "W100")).venueRatings,
    after.items[0].venueRatings,
  );
});
