import type { CapabilityProfile } from "@confucius/protocol";

export interface CapabilityPathApi {
  isAbsolute(path: string): boolean;
  normalize(path: string): string;
}

export interface CapabilitySettings {
  capabilityProfile: CapabilityProfile;
  workingDirectory?: string;
}

export interface CapabilityPreview extends CapabilitySettings {
  confirmationRequired: boolean;
}

interface CapabilityRequest {
  capabilityProfile?: unknown;
  workingDirectory?: unknown;
  confirmed?: unknown;
}

function canonicalDirectory(path: string, paths: CapabilityPathApi): string {
  const normalized = paths.normalize(path);
  const withoutTrailingSeparators = normalized.replace(/[\\/]+$/, "");
  if (!withoutTrailingSeparators) return normalized;
  if (/^[A-Za-z]:$/.test(withoutTrailingSeparators)) {
    return `${withoutTrailingSeparators}${normalized.slice(-1)}`;
  }
  return withoutTrailingSeparators;
}

/** Validate and canonicalize a capability choice without granting it. */
export function previewCapabilityRequest(
  request: CapabilityRequest,
  current: CapabilitySettings | undefined,
  paths: CapabilityPathApi,
): CapabilityPreview {
  const capabilityProfile: CapabilityProfile =
    request.capabilityProfile === "workspace" ? "workspace" : "zotero_only";
  if (capabilityProfile === "zotero_only") {
    return { capabilityProfile, confirmationRequired: false };
  }

  const requested = String(request.workingDirectory ?? "").trim();
  if (!requested) {
    throw new Error("A working directory is required for workspace access");
  }
  if (!paths.isAbsolute(requested)) {
    throw new Error("Working directory must be an absolute path");
  }
  const workingDirectory = canonicalDirectory(requested, paths);
  if (!workingDirectory || !paths.isAbsolute(workingDirectory)) {
    throw new Error("Working directory normalization failed");
  }

  return {
    capabilityProfile,
    workingDirectory,
    confirmationRequired:
      current?.capabilityProfile !== "workspace" ||
      current.workingDirectory !== workingDirectory,
  };
}

/**
 * Resolve an explicit capability change at the host boundary. Zotero-only
 * tasks never retain a workspace path, and a new or changed workspace grant
 * always requires confirmation after normalization.
 */
export function normalizeCapabilityRequest(
  request: CapabilityRequest,
  current: CapabilitySettings | undefined,
  paths: CapabilityPathApi,
): CapabilitySettings {
  const preview = previewCapabilityRequest(request, current, paths);
  if (preview.confirmationRequired && request.confirmed !== true) {
    throw new Error("Confirm the normalized working directory first");
  }
  return preview.workingDirectory
    ? {
        capabilityProfile: preview.capabilityProfile,
        workingDirectory: preview.workingDirectory,
      }
    : { capabilityProfile: preview.capabilityProfile };
}

/** Fail closed when a persisted v2 task contains an incomplete path grant. */
export function repairPersistedCapabilities(
  value: CapabilitySettings,
  paths: CapabilityPathApi,
): CapabilitySettings {
  if (value.capabilityProfile !== "workspace") {
    return { capabilityProfile: "zotero_only" };
  }
  const requested = String(value.workingDirectory ?? "").trim();
  if (!requested || !paths.isAbsolute(requested)) {
    return { capabilityProfile: "zotero_only" };
  }
  try {
    const workingDirectory = canonicalDirectory(requested, paths);
    return workingDirectory && paths.isAbsolute(workingDirectory)
      ? { capabilityProfile: "workspace", workingDirectory }
      : { capabilityProfile: "zotero_only" };
  } catch {
    return { capabilityProfile: "zotero_only" };
  }
}
