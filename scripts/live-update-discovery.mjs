/** Exercise the installed updater against GitHub, including an omitted list asset. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { IsolatedZotero } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_DISCOVERY_OUTPUT ?? "output/update-discovery",
);
const target = process.env.CONFUCIUS_DISCOVERY_TARGET ?? "0.5.0-beta.5";
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi: resolve(
    process.env.CONFUCIUS_DISCOVERY_XPI ??
      "apps/zotero-addon/.scaffold/build/confucius.xpi",
  ),
  prefix: "update-discovery-",
});
const report = { target, checks: [] };
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const h=Zotero.Confucius.hooks.host,q=Zotero.__updateDiscovery;${code}`,
  );
const check = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
try {
  report.environment = await instance.launch();
  await evaluate(`Zotero.__updateDiscovery={calls:[],original:Zotero.HTTP.request,version:h.updates.currentVersion,omit:false};const qa=Zotero.__updateDiscovery;
    h.updates.currentVersion='0.5.0-beta.4';
    Zotero.HTTP.request=async function(method,url,...args){qa.calls.push(url);const r=await qa.original.call(this,method,url,...args);if(qa.omit&&url.includes('/releases?'))return {...r,response:r.response.map(item=>item.tag_name===${JSON.stringify("v" + target)}?{...item,assets:[]}:item)};return r;};return true;`);
  const actual = await instance.rpc("update/setPrerelease", { enabled: true });
  assert.equal(actual.state, "available", JSON.stringify(actual));
  assert.equal(actual.availableVersion, target);
  report.realDiscovery = actual;
  report.realCalls = await evaluate("return q.calls;");
  check(
    "Installed updater discovers the real public target without replacing its check implementation",
  );

  await evaluate("q.omit=true;q.calls=[];return true;");
  const omitted = await instance.rpc("update/check");
  assert.equal(omitted.state, "available", JSON.stringify(omitted));
  assert.equal(omitted.availableVersion, target);
  const recovered = await evaluate(
    "return {calls:q.calls,pending:h.updates.pendingRelease};",
  );
  assert.ok(
    recovered.calls.some((url) =>
      /\/releases\/\d+\/assets\?per_page=100$/.test(url),
    ),
  );
  assert.match(recovered.pending.digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(recovered.pending.size > 0);
  report.recovered = recovered;
  check(
    "An omitted list asset is recovered through the real anonymous asset endpoint with checksum and size",
  );

  await evaluate("q.calls=[];return true;");
  const stable = await instance.rpc("update/setPrerelease", { enabled: false });
  assert.equal(stable.state, "up-to-date");
  assert.equal(stable.canInstall, false);
  assert.equal(
    await evaluate(
      "return q.calls.some(url=>/\\/releases\\/\\d+\\/assets/.test(url));",
    ),
    false,
  );
  check("Stable-only users neither discover the Beta nor request its assets");
  await evaluate(
    "Zotero.HTTP.request=q.original;h.updates.currentVersion=q.version;return true;",
  );
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await instance.stop({ graceful: true });
}
