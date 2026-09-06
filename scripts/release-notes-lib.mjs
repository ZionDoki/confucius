const NUMBER = "(?:0|[1-9]\\d*)";
const RELEASE_VERSION = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-beta\\.[1-9]\\d*)?$`,
);

/** Validate the public release contract and return the curated Release body. */
export function releaseNotes(version, tag, changelog) {
  if (
    !RELEASE_VERSION.test(version) ||
    version
      .split("-")[0]
      .split(".")
      .some((part) => !Number.isSafeInteger(Number(part))) ||
    tag !== `v${version}`
  ) {
    throw new Error(
      `Release tag ${tag ?? "(missing)"} must match v${version}; use X.Y.Z or X.Y.Z-beta.N (N >= 1).`,
    );
  }
  const sections = changelog.split(/^## /m);
  const matches = sections.filter((section) =>
    section.startsWith(`${version} - `),
  );
  if (matches.length !== 1) {
    throw new Error(
      `CHANGELOG.md needs exactly one entry for ${version}; found ${matches.length}.`,
    );
  }
  const current = matches[0];
  const newline = current.indexOf("\n");
  const heading = (newline === -1 ? current : current.slice(0, newline)).trim();
  const date = heading.slice(`${version} - `.length);
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(
      `CHANGELOG.md entry for ${version} needs a valid YYYY-MM-DD release date.`,
    );
  }
  const body = newline === -1 ? "" : current.slice(newline + 1).trim();
  const content = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#{1,6}[^\n]*$/gm, "")
    .trim();
  if (
    !content ||
    /^(?:[-*]\s*)?(?:TODO|TBD|待补充|待填写)(?:\s|[:：.!。]|$)/im.test(content)
  ) {
    throw new Error(
      `CHANGELOG.md entry for ${version} needs release notes, not empty sections or placeholders.`,
    );
  }
  const previous = sections
    .slice(sections.indexOf(current) + 1)
    .map((section) => section.match(/^([^\s]+) - /)?.[1])
    .find(
      (candidate) =>
        candidate &&
        RELEASE_VERSION.test(candidate) &&
        (version.includes("-beta.") || !candidate.includes("-")),
    );
  return previous
    ? `${body}\n\n**Full Changelog**: https://github.com/ZionDoki/confucius/compare/v${previous}...${tag}\n`
    : `${body}\n`;
}
