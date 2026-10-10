# Literature research

English · [简体中文](literature-research.zh-CN.md)

[User guide](README.md)

## Find your first papers

Try: “Find recent papers on graph neural networks for molecular prediction.
Recommend the most relevant ones and explain your choices.”

1. Ask in a new conversation; no attached paper is required.
2. Open the **Literature** capsule above the composer.
3. Read the abstracts and selection reasons; check or uncheck candidates.
4. Choose **Review selection → Confirm and acquire fulltext** to save the
   selected papers to your personal Zotero library and attempt PDF downloads.

Matching library items and verified attachments are reused. Changing candidates
requires a new confirmation. Removing a confirmed candidate unbinds the source;
it does not delete the Zotero item or PDF.

## Understand the counts

“9 / 100” means **9 selected candidates out of 100 fetched, deduplicated papers**.
It is not the search service's total hit count.

**Search criteria** makes a network request; **Filter current results** searches
only the local pool. Each OpenAlex page fetches at most 100 records. Missing
abstracts can be looked up from local Zotero, OpenAlex and Crossref metadata.

## Continue without every PDF

| Choice                        | What happens                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Continue with abstracts       | Continue without importing or downloading this batch.                                        |
| Continue with current results | Use available PDFs and abstracts; already authorized downloads may finish in the background. |
| Confirm and acquire fulltext  | Import the selected papers, bind them to this task and download available PDFs.              |

These choices apply to the current candidate selection. Reports must distinguish
full-text, abstract-only and metadata-only evidence. Obtaining a PDF does not mean
the Agent has read it.

## Optional service keys

In **Settings → Runtime**, you can configure:

- **OpenAlex Key:** used for OpenAlex requests and required for its cached PDFs.
  The plugin can send metadata requests without a key; the service may limit or
  reject them.
  [Get a key](https://openalex.org/settings/api).
- **Tavily Key:** enables a search provider for supplemental full-text discovery.
  Search and connection tests use the provider's quota. Without a usable key,
  Confucius can try public HTML search.

Keys stay in host settings and are not sent to the model. Searches send the
query, paper title or DOI to the selected service. A successful connection test
does not guarantee that a paper is available.

## When a PDF is missing

Confucius tries existing attachments, source links, Zotero resolvers and repository
metadata. On supported Zotero versions it can render public pages in an isolated
browser. If full text is needed, the Agent can investigate observed links for
failed papers in the unchanged, confirmed batch.

Downloads must parse as PDFs and match the first-page title plus DOI or author.
Supplements, review files and mismatched papers are rejected. Versions may be
published, accepted, preprint or unknown; a clear PDF version statement takes
precedence over source metadata.

For a paper that still fails:

1. Choose **Get from browser**.
2. Download it using your own access.
3. Drop the PDF onto **that paper's drop target** in the literature list.

The original file stays in place; a verified copy is attached to Zotero.
The limit is **100 MiB per PDF**. Scans or unusual front matter may require manual
verification in Zotero.

## Limits and recovery

- Account login and human CAPTCHA use your browser. Browser login cookies are
  not imported into Confucius.
- Local/private network download addresses are rejected. Some VPN or proxy DNS
  setups therefore require a manual browser download.
- Two papers download concurrently. Each acquisition has an approximately
  three-minute deadline; individual failed papers can be retried.
- Supplemental exploration has per-paper limits: two searches, three download
  candidates and twelve steps per confirmed revision. Provider cooldowns are
  shared, so repeatedly asking about other papers will not bypass them.
- Cancel, candidate changes and choosing to continue with current results stop
  new supplemental acquisition. Closing the workspace alone does not stop work.
- Restart preserves saved results and marks interrupted downloads for retry;
  it does not automatically restart research.

## Research subagents

The main Agent can delegate focused reading or comparison, with up to three
running subagents. Open a subagent's activity entry to inspect its public progress,
tools and conclusion. Closing the viewer does not stop it.

Subagents receive assigned sources and background. They cannot approve writes,
change candidates, modify notes or annotations, or delegate again. Stopping or
deleting the parent request cancels associated work. Their findings remain
distinct from evidence the main Agent read directly.
