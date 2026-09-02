import {
  parseSkillMarkdown,
  type ConfuciusSkill,
} from "@confucius/skill-format";
import { BUILTIN_SKILLS } from "../skills/builtin";

export class SkillStore {
  private readonly skills = new Map<string, ConfuciusSkill>();

  loadBuiltins(): ConfuciusSkill[] {
    this.skills.clear();
    for (const [slug, markdown] of Object.entries(BUILTIN_SKILLS)) {
      const skill = parseSkillMarkdown(
        slug,
        `builtin://confucius/skills/${slug}`,
        markdown,
      );
      if (skill) {
        this.skills.set(slug, skill);
      }
    }
    return this.list();
  }

  list(): ConfuciusSkill[] {
    return [...this.skills.values()];
  }

  get(slug: string): ConfuciusSkill | undefined {
    return this.skills.get(slug);
  }
}
