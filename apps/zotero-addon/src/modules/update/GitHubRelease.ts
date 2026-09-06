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

export function selectUpdate(
  data: unknown,
  currentVersion: string,
  includePrerelease: boolean,
): ReleaseUpdate | null {
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
  if (!latest) return null;
  const asset = (Array.isArray(latest.assets) ? latest.assets : [])
    .map(record)
    .find((item) => item.name === "confucius.xpi" && item.state === "uploaded");
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

export async function fetchReleases(): Promise<unknown> {
  const response = await Zotero.HTTP.request("GET", RELEASES_URL, {
    responseType: "json",
    headers: {
      Accept: "application/vnd.github+json",
      "Cache-Control": "no-cache",
    },
    timeout: 30_000,
  });
  return response.response;
}
