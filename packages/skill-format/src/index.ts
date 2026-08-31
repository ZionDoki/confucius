export interface ConfuciusSkill {
  slug: string;
  name: string;
  description: string;
  allowedTools: string[];
  triggers: string[];
  body: string;
  path: string;
}

export function parseSkillMarkdown(
  slug: string,
  path: string,
  raw: string,
): ConfuciusSkill | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }
  const { frontmatter, body } = splitFrontmatter(normalized);
  const meta = parseFrontmatter(frontmatter);
  const name = meta.name || slug;
  const description = meta.description || "";
  if (!body) {
    return null;
  }
  return {
    slug,
    name,
    description,
    allowedTools: meta.allowedTools,
    triggers: meta.triggers,
    body,
    path,
  };
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: "", body: raw.trim() };
  }
  const end = raw.indexOf("\n---", 4);
  if (end < 0) {
    return { frontmatter: "", body: raw.trim() };
  }
  return {
    frontmatter: raw.slice(4, end).trim(),
    body: raw.slice(end + 4).trim(),
  };
}

function parseFrontmatter(frontmatter: string): {
  name?: string;
  description?: string;
  allowedTools: string[];
  triggers: string[];
} {
  const allowedTools: string[] = [];
  const triggers: string[] = [];
  let name: string | undefined;
  let description: string | undefined;
  let list: "allowed-tools" | "triggers" | null = null;

  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const listItem = line.match(/^-\s+(.+)$/);
    if (listItem && list) {
      const value = stripQuotes(listItem[1]);
      if (list === "allowed-tools") {
        allowedTools.push(value);
      } else {
        triggers.push(value);
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      list = null;
      continue;
    }
    const key = kv[1];
    const value = stripQuotes(kv[2]);
    if (key === "name") {
      name = value || undefined;
      list = null;
    } else if (key === "description") {
      description = value;
      list = null;
    } else if (key === "allowed-tools") {
      list = "allowed-tools";
      if (value) {
        allowedTools.push(
          ...value
            .split(/[,\s]+/)
            .map((part) => part.trim())
            .filter(Boolean),
        );
      }
    } else if (key === "triggers") {
      list = "triggers";
      if (value) {
        triggers.push(value);
      }
    } else {
      list = null;
    }
  }

  return { name, description, allowedTools, triggers };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
