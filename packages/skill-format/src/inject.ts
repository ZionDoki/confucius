import type { ConfuciusSkill } from "./types";

/** Host tool the model calls to load a skill body (Agent Skills activation). */
export const SKILL_TOOL_NAME = "skill";

/**
 * Composer builtins that must not be parsed as skill slugs. Keep in sync with
 * the workspace slash menu.
 */
export const RESERVED_SLASH_COMMANDS = new Set([
  "agent",
  "plan",
  "ask",
  "auto",
  "deny-writes",
  "model",
  "compact",
]);

export const DEFAULT_SKILL_USER_TEXT =
  "Follow the loaded skill instructions for the current Zotero context.";

export interface SkillInvocation {
  slug: string | null;
  rest: string;
}

/**
 * First token after `/` for the slash menu, or null when the menu should close.
 * An empty string means `/` with no filter. A space after the token means the
 * user is typing arguments, so the menu hides.
 */
export function slashMenuToken(value: string): string | null {
  if (!value.startsWith("/")) {
    return null;
  }
  const inner = value.slice(1);
  if (/\s/.test(inner)) {
    return null;
  }
  return inner;
}

/**
 * Detect a user-explicit skill invocation: `/slug args` or a unique trigger
 * such as `/精读`. Reserved composer commands are left untouched.
 */
export function parseSkillInvocation(
  text: string,
  skills: readonly ConfuciusSkill[],
): SkillInvocation {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { slug: null, rest: "" };
  }
  const token = match[1];
  const rest = (match[2] ?? "").trim();
  if (RESERVED_SLASH_COMMANDS.has(token.toLowerCase())) {
    return { slug: null, rest: "" };
  }
  const lower = token.toLowerCase();
  const bySlug = skills.find((skill) => skill.slug.toLowerCase() === lower);
  if (bySlug) {
    return { slug: bySlug.slug, rest };
  }
  const byTrigger = skills.filter((skill) =>
    skill.triggers.some((trigger) => trigger.toLowerCase() === lower),
  );
  if (byTrigger.length === 1) {
    return { slug: byTrigger[0].slug, rest };
  }
  return { slug: null, rest: "" };
}

export function formatInvokedUserText(slug: string, rest: string): string {
  if (rest) {
    return `The user invoked /${slug}.\n\n${rest}`;
  }
  return `The user invoked /${slug}. ${DEFAULT_SKILL_USER_TEXT}`;
}

/**
 * Progressive disclosure for the system prompt:
 * 1. Catalog — name, description, triggers (always).
 * 2. Loaded bodies — full SKILL.md text for skills the user or model activated.
 *
 * `allowed-tools` is listed as a preference. It must not be described as an
 * exclusive sandbox; other tools stay available.
 */
export function formatSkillPromptSection(options: {
  skills: readonly ConfuciusSkill[];
  loaded: readonly ConfuciusSkill[];
}): string {
  if (!options.skills.length) {
    return "";
  }
  const lines = [
    "Skills use progressive disclosure. The list below is metadata only (~name and when to use it).",
    "When a task matches a skill, call the `skill` tool with that slug to load its full instructions before you proceed.",
    "The user may also invoke a skill by sending `/slug` plus optional arguments.",
    "Loading a skill adds procedure; it does not remove your other tools.",
    "Available skills:",
  ];
  for (const skill of options.skills) {
    const when = skill.triggers.length
      ? ` Use when: ${skill.triggers.join("; ")}.`
      : "";
    const description = skill.description || skill.name;
    lines.push(`- ${skill.slug}: ${description}.${when}`);
  }
  if (options.loaded.length) {
    lines.push("", "Loaded skill instructions (follow these):");
    for (const skill of options.loaded) {
      lines.push("", `## ${skill.slug} (${skill.name})`);
      if (skill.allowedTools.length) {
        lines.push(
          `Preferred tools: ${skill.allowedTools.join(", ")}. Other tools remain available.`,
        );
      }
      lines.push(skill.body);
    }
  }
  return lines.join("\n");
}
