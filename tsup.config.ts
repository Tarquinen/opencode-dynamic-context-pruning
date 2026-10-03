import { defineConfig } from "tsup"

export default defineConfig({
    entry: ["index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    noExternal: [
        "jsonc-parser", // Bundle this to fix its broken ESM imports
        // tool() is a value import, not `import type`, so it survives into
        // dist/index.js. @opencode-ai/plugin is a peer dependency and opencode
        // installs plugins into its own cache without providing it, so the
        // import threw before DCP ran and the plugin was dropped silently.
        "@opencode-ai/plugin",
    ],
})
