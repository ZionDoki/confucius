const REPOSITORY = "ZionDoki/confucius";
export const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;

export interface ReleaseUpdate {
  version: string;
  downloadURL: string;
  digest: string;
  size: number;
}

interface Version {
  numbers: number[];
  prerelease: string[];
}

function parseVersion(value: string): Version {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    );
  if (!match) throw new Error(`Invalid release version: ${value}`);
  const numbers = match.slice(1, 4).map(Number);
  const prerelease = match[4]?.split(".") ?? [];
  if (
    numbers.some((n) => !Number.isSafeInteger(n)) ||
    prerelease.some((id) => /^0\d+$/.test(id))
  )
    throw new Error(`Invalid release version: ${value}`);
  return { numbers, prerelease };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left),
    b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i],
      y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn && x.length !== y.length) return x.length - y.length;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function latestRelease(
  data: unknown,
  currentVersion: string,
  includePrerelease: boolean,
) {
  parseVersion(currentVersion);
  if (!Array.isArray(data) || !data.length)
    throw new Error(
      "GitHub returned no release information. Please try again.",
    );
  let latest: Record<string, unknown> | undefined;
  for (const value of data) {
    const release = record(value);
    if (release.draft === true) continue;
    if (typeof release.tag_name !== "string")
      throw new Error("GitHub returned invalid release information.");
    const version = parseVersion(release.tag_name);
    if (
      !includePrerelease &&
      (release.prerelease === true || version.prerelease.length)
    )
      continue;
    if (compareVersions(release.tag_name, currentVersion) <= 0) continue;
    if (
      !latest ||
      compareVersions(release.tag_name, latest.tag_name as string) > 0
    )
      latest = release;
  }
  return latest;
}

function installationAsset(release: Record<string, unknown>) {
  return (Array.isArray(release.assets) ? release.assets : [])
    .map(record)
    .find((item) => item.name === "confucius.xpi" && item.state === "uploaded");
}

export function selectUpdate(
  data: unknown,
  currentVersion: string,
  includePrerelease: boolean,
): ReleaseUpdate | null {
  const latest = latestRelease(data, currentVersion, includePrerelease);
  if (!latest) return null;
  const asset = installationAsset(latest);
  if (!asset)
    throw new Error(
      `Release ${String(latest.tag_name)} has no Confucius installation package yet. Please try again later.`,
    );
  if (
    typeof asset.url !== "string" ||
    !/^https:\/\/api\.github\.com\/repos\/ZionDoki\/confucius\/releases\/assets\/\d+$/.test(
      asset.url,
    )
  )
    throw new Error("Invalid Confucius download address.");
  if (
    typeof asset.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)
  )
    throw new Error(
      "The release is missing its SHA-256 checksum. Please try again later.",
    );
  if (
    typeof asset.size !== "number" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 30 * 1024 * 1024
  )
    throw new Error("Invalid Confucius package size.");
  return {
    version: (latest.tag_name as string).replace(/^v/, ""),
    downloadURL: asset.url,
    digest: asset.digest.toLowerCase(),
    size: asset.size,
  };
}

/** A release-list snapshot can omit already uploaded assets. Check only the
 * newest eligible release before treating a missing package as an error. */
export async function resolveUpdate(
  data: unknown,
  currentVersion: string,
  includePrerelease: boolean,
  loadAssets: (releaseId: number) => Promise<unknown> = fetchReleaseAssets,
): Promise<ReleaseUpdate | null> {
  const latest = latestRelease(data, currentVersion, includePrerelease);
  if (!latest) return null;
  let complete = latest;
  if (
    !installationAsset(latest) &&
    typeof latest.id === "number" &&
    Number.isSafeInteger(latest.id) &&
    latest.id > 0
  ) {
    const assets = await loadAssets(latest.id);
    if (!Array.isArray(assets))
      throw new Error(
        "GitHub returned invalid release assets. Please try again.",
      );
    complete = { ...latest, assets };
  }
  // Reuse all channel, address, size and checksum checks; never accept an older
  // version or an unchecked browser download when the selected release is broken.
  return selectUpdate([complete], currentVersion, includePrerelease);
}

async function githubJson(url: string): Promise<unknown> {
  const response = await Zotero.HTTP.request("GET", url, {
    responseType: "json",
    headers: {
      Accept: "application/vnd.github+json",
      "Cache-Control": "no-cache",
    },
    timeout: 30_000,
  });
  return response.response;
}

export function fetchReleases(): Promise<unknown> {
  return githubJson(RELEASES_URL);
}

export function fetchReleaseAssets(releaseId: number): Promise<unknown> {
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0)
    throw new Error("Invalid GitHub release ID.");
  // Construct the URL ourselves; do not follow an assets_url from response data.
  return githubJson(
    `https://api.github.com/repos/${REPOSITORY}/releases/${releaseId}/assets?per_page=100`,
  );
}
