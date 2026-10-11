import { readFile } from "node:fs/promises";
import { URL } from "node:url";

export async function load(url, context, nextLoad) {
  if (new URL(url).pathname.endsWith(".css")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(await readFile(new URL(url), "utf8"))};`,
    };
  }
  return nextLoad(url, context);
}
