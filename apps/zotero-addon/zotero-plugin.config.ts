import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { resolveZoteroExecutable } from "./src/development/zoteroExecutable";

// c12 loads .env before evaluating this config. Resolve before Serve reads its
// binary path (serve:init runs too late), and leave build/release independent
// of a locally installed Zotero, including on CI.
if (process.argv.slice(2).includes("serve")) {
  const executable = resolveZoteroExecutable();
  process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH = executable.path;
  console.info(`[Confucius] Zotero (${executable.source}): ${executable.path}`);
}

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/ZionDoki/confucius/releases/latest/download/update.json`,
  xpiDownloadLink:
    "https://github.com/ZionDoki/confucius/releases/download/v{{version}}/confucius.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV ?? "production"}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  server: {
    devtools: false,
  },
});
