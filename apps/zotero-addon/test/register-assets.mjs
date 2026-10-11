import { register } from "node:module";

// Match the add-on bundler's text loader when UI modules import shared CSS.
register("./asset-loader.mjs", import.meta.url);
