import assert from "node:assert/strict";
import { test } from "node:test";
import { isApprovalResolution } from "./permissions";

test("approval resolutions require an explicit decision, identity, scope and object arguments", () => {
  const valid = { id: "approval", verdict: "allow", scope: "once" };
  for (const value of [
    null,
    undefined,
    [],
    "allow",
    {},
    { ...valid, id: "" },
    { ...valid, verdict: undefined },
    { ...valid, verdict: "reject" },
    { ...valid, scope: undefined },
    { ...valid, scope: "all" },
    { ...valid, editedArgs: null },
    { ...valid, editedArgs: [] },
    { ...valid, editedArgs: "args" },
  ])
    assert.equal(isApprovalResolution(value), false, JSON.stringify(value));
  for (const verdict of ["allow", "deny"])
    for (const scope of ["once", "session", "always"]) {
      assert.equal(isApprovalResolution({ ...valid, verdict, scope }), true);
      assert.equal(
        isApprovalResolution({
          ...valid,
          verdict,
          scope,
          editedArgs: { name: "edited" },
        }),
        true,
      );
    }
});
