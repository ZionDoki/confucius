export interface ConfuciusSkill {
  slug: string;
  name: string;
  description: string;
  allowedTools: string[];
  triggers: string[];
  body: string;
  path: string;
}
