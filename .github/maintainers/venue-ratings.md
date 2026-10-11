# Venue rating catalogs

English · [简体中文](venue-ratings.zh-CN.md)

[Maintainer guide](README.md) · [User guide](../../docs/literature-research.md#venue-ratings)

## Bundled sources

The built-in factual snapshot contains CCF seventh-edition 2026 journals and
conferences (681 entries) and ranked ICORE2026 conferences (825 entries).
It contains bibliographic names, abbreviations, grades and CCF categories in
Confucius's own schema, with official URLs and immutable community snapshot links:

- CCF: [haozhou-wong/ccf-recommended-list-2026-markdown at dcf1a023](https://github.com/haozhou-wong/ccf-recommended-list-2026-markdown/blob/dcf1a02335fb44dcaf785997d5c535ab41628a16/data/ccf-2026.json),
  transcribed from the [official seventh-edition PDF](https://www.ccf.org.cn/ccf/contentcore/resource/download?ID=112CF3BF7E1140ACEB271ADAED12A67ADFABB8FF099E40C2759502A85C8A281F).
- CORE: [qirunzeng/VenueRank-Lens at a68b51cb](https://github.com/qirunzeng/VenueRank-Lens/blob/a68b51cbf0eaa2bce03b6a51dfffca239ceba857/WebExtension/core_catalog.json),
  derived from the [official ICORE2026 export](https://portal.core.edu.au/conf-ranks/?search=&by=all&source=ICORE2026&do=Export).

Upstream implementations describe their software as MIT; that does not change
the ownership of the source publications. No upstream implementation is copied.
ShowJCR software is GPL-3.0; Confucius ships neither its implementation nor its
JCR, CAS or Xinrui datasets. Those catalogs come exclusively from a user's local
CSV, and the interface identifies the import filename and ShowJCR source.

`scripts/sync-venue-catalogs.mjs` pins both commits, validates edition/count/grade
and writes the generated `host/data/venueCatalogs.json` with original-content
SHA-256 values. Run `npm run sync-venue-catalogs:check` to check reproducibility
against the pinned GitHub files. Updating a pin requires checking the official
edition and reviewing identity/rank changes, followed by regeneration and tests.
Ordinary searches use the bundled file and make no catalog network request.

Nine reviewed main-conference abbreviations have exact alternate full titles
from the other system: NeurIPS, AAAI, ACL, EMNLP, ICML, ICLR, CVPR, ICCV and SIGIR.
The generator requires a unique conference entry in each system. It does not
infer arbitrary aliases from similar titles or conference acronyms.

## Matching and projection

OpenAlex conversion retains source IDs, source types, ISSN-L/ISSNs and original
source names. Publication venues exclude repositories. Match by ISSN first,
then exact normalized names, reviewed full-title aliases and abbreviations.
Conflicting ISSNs and identity collisions suppress the match. Normalization
handles Unicode, punctuation, case and ampersands. A conference's anchored
“Proceedings of the” prefix can be removed before exact full-title lookup;
original source/track names still determine scope. It does not use substring,
edit-distance or model-based inference.

Explicit preprints do not borrow ratings from published versions. Unidentified
book series do not count as conferences; an exact original conference name can
identify a proceedings record. Findings, demonstrations, short/companion tracks
and companion workshops do not borrow a main conference grade. An independently
listed workshop can match its own full name or abbreviation.

`LiteratureService.list/get/review` projects current ratings without persisting
them into pool decisions or incrementing either revision. UI and all three
runtime tool paths read the same projection. The review adapter adds a metadata
key so serialized snapshot loads can refresh at an equal domain revision;
older domain revisions and identical metadata remain ignored. Candidate choices,
confirmation, arrival cues and annotation revision handling keep their existing
semantics. Metadata views expose the catalog
edition, sources and categories; status-only views remain compact. CSV data is
untrusted metadata, never agent instructions or evidence of paper quality.

## Local import contract

The user RPCs are `literature/ratings/list`, `literature/ratings/import` (a local
file path) and `literature/ratings/remove` (an imported catalog ID). The agent tool
registry has no import/removal tool. Import refresh emits `literature_updated`
for loaded tasks without arrivals or revision changes. Both UI import entrances
reuse `venueRatings.ts`; review uses the shared annotation/candidate component.

The parser accepts ShowJCR journal CSV headers for JCR, CAS and Xinrui, including
UTF-8 BOM, quoted commas/newlines and escaped quotes. It retains every available
subject/major/minor category, quartile, rank position, Top flag and impact factor.
Year comes from consistent indicator headers, row years and a standard filename
when present. Missing/conflicting years or mismatched columns reject the entire
file. CAS ends at 2025; Xinrui remains a distinct system. Conference CSVs and
arbitrary CSV schemas are unsupported.

Files must be regular UTF-8 CSVs no larger than 32 MiB. Parser bounds are 60,000
data rows, 160 columns and 16,384 characters per field. Imported catalogs live
under the local profile's `confucius/runtime-v1/venue-ratings/catalogs.json`, with
schema version 1 and IDs `<system>_<year>`. Same-year imports replace only that
system/edition. Newest-year selection is per system; older editions remain until
removed. Saves are serialized and atomic; parse/write failures leave the old
in-memory and saved catalog unchanged. Damaged imports explicitly report
unavailability while built-in matching and research remain usable.

Imports never change tags, Zotero fields, candidate decisions, write permissions,
confirmation or acquisition. They persist across task changes and Zotero restarts.

## Validation

Run `npm test`, `npm run typecheck`, `npm run sync-venue-catalogs:check` and
`npm run build`. `node --import tsx scripts/live-venue-ratings.mjs` installs the
ordinary built XPI in an isolated Zotero profile and tests real host events,
local CSV reads/storage, cards/list display and restart. The model/OpenAlex
transport and CSV picker selection use deterministic fixtures; the fixture
indicator values are fictional. Raw data, screenshots and results stay under
ignored `output/`. See the [2026-10-11 acceptance record](acceptance/venue-ratings-2026-10-11.md)
for actual platform results.
