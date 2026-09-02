import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SkillStore } from "./SkillStore";
import { SkillToolProvider } from "./SkillToolProvider";

describe("SkillToolProvider", () => {
  it("loads a builtin skill body without filtering other tools", async () => {
    const store = new SkillStore();
    store.loadBuiltins();
    const loaded: string[] = [];
    const provider = new SkillToolProvider(store, (skill) => {
      loaded.push(skill.slug);
    });
    assert.deepEqual(
      provider.listTools().map((tool) => tool.name),
      ["skill"],
    );
    const result = await provider.call("skill", { slug: "paper-deep-reading" });
    assert.equal(result.ok, true);
    if (result.ok) {
      const data = result.data as {
        slug: string;
        instructions: string;
        preferredTools: string[];
      };
      assert.equal(data.slug, "paper-deep-reading");
      assert.ok(data.instructions.length > 20);
      assert.ok(data.preferredTools.includes("get_outline"));
    }
    assert.deepEqual(loaded, ["paper-deep-reading"]);
  });

  it("rejects unknown slugs", async () => {
    const store = new SkillStore();
    store.loadBuiltins();
    const provider = new SkillToolProvider(store, () => undefined);
    const result = await provider.call("skill", { slug: "nope" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "not_found");
      assert.match(result.message, /paper-deep-reading/);
    }
  });
});
