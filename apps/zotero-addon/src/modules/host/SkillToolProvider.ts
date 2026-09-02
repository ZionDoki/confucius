import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";
import { SKILL_TOOL_NAME, type ConfuciusSkill } from "@confucius/skill-format";
import type { SkillStore } from "./SkillStore";

export const SKILL_TOOL_DEFINITION: ToolDefinition = {
  name: SKILL_TOOL_NAME,
  description:
    "Load the full instructions for a skill by slug. Call this when the user's task matches a listed skill. Returns the skill body to follow for the rest of the turn. Loading a skill does not remove other tools.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "Skill slug from the available-skills list, for example paper-deep-reading",
      },
    },
    required: ["slug"],
    additionalProperties: true,
  },
};

const SKILL_TOOL_META: ToolRuntimeMeta = {
  name: SKILL_TOOL_NAME,
  catalog: "agent",
  concurrency: "parallel_safe",
  mutatesState: false,
};

/**
 * Model-facing activation tool. The tool result carries the SKILL.md body for
 * this turn; `onLoad` records the slug so later turns keep it in the prompt.
 */
export class SkillToolProvider implements ToolProvider {
  constructor(
    private readonly store: SkillStore,
    private readonly onLoad: (skill: ConfuciusSkill) => void,
  ) {}

  listTools(): ToolDefinition[] {
    return [SKILL_TOOL_DEFINITION];
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    return name === SKILL_TOOL_NAME ? SKILL_TOOL_META : null;
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    return name === SKILL_TOOL_NAME
      ? SKILL_TOOL_DEFINITION.inputSchema
      : undefined;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (name !== SKILL_TOOL_NAME) {
      return {
        ok: false,
        toolName: name,
        code: "not_found",
        message: `Unknown tool: ${name}`,
      };
    }
    const slug = String(args.slug ?? args.name ?? "").trim();
    const skill = this.store.get(slug);
    if (!skill) {
      const known = this.store
        .list()
        .map((item) => item.slug)
        .join(", ");
      return {
        ok: false,
        toolName: name,
        code: "not_found",
        message: known
          ? `Unknown skill "${slug}". Known slugs: ${known}`
          : `Unknown skill "${slug}"`,
      };
    }
    this.onLoad(skill);
    return {
      ok: true,
      toolName: name,
      data: {
        slug: skill.slug,
        name: skill.name,
        instructions: skill.body,
        preferredTools: skill.allowedTools,
      },
    };
  }
}
