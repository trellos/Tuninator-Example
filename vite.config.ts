import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * The library's built AudioWorklet asset, inside the installed package.
 *
 * `tuninator` is an ordinary npm dependency, so this resolves through the
 * package's own `exports` map (`"./worklet"`) rather than guessing at a path
 * inside `node_modules/`. A failure here means the dependency is not installed,
 * which is worth failing loudly for -- everything else in this config assumes
 * it is.
 */
const WORKLET_SRC = require.resolve("tuninator/worklet");
const WORKLET_DEST_DIR = path.join(here, "public", "assets");
const WORKLET_DEST = path.join(WORKLET_DEST_DIR, "tuninator-worklet.js");

/**
 * Copies the package's `tuninator-worklet.js` into `public/assets/` so the demo
 * can hand the library a `workletUrl` of `/assets/tuninator-worklet.js`.
 *
 * An AudioWorklet is fetched by URL at runtime rather than imported, so it has
 * to exist as a served file -- the bundler never sees it as a module.
 */
function copyWorkletPlugin(): Plugin {
  let lastCopiedMtimeMs = -1;

  const copy = (logger: { info: (m: string) => void }): void => {
    const mtimeMs = statSync(WORKLET_SRC).mtimeMs;
    if (mtimeMs === lastCopiedMtimeMs) return;
    mkdirSync(WORKLET_DEST_DIR, { recursive: true });
    copyFileSync(WORKLET_SRC, WORKLET_DEST);
    lastCopiedMtimeMs = mtimeMs;
    logger.info(`[tuninator] copied worklet -> public/assets/tuninator-worklet.js`);
  };

  return {
    name: "tuninator-copy-worklet",
    buildStart() {
      copy({ info: (m) => this.info(m) });
    },
    configureServer(server) {
      copy({ info: (m: string) => server.config.logger.info(m) });
      // Pick the worklet up again if the dependency is reinstalled or relinked
      // while the dev server is running.
      server.watcher.add(WORKLET_SRC);
      const onChange = (file: string): void => {
        if (path.resolve(file) === WORKLET_SRC) copy({ info: (m) => server.config.logger.info(m) });
      };
      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
    },
  };
}

export default defineConfig({
  // A GitHub Pages project site serves from a subpath (e.g. "/tuninator-example/"),
  // not the domain root. The deploy workflow sets BASE_PATH from the actual repo
  // name; local dev and preview fall back to "/". Consumers read this back via
  // `import.meta.env.BASE_URL`, which Vite derives from `base` -- see
  // WORKLET_URL in src/main.ts, which would otherwise 404 under a subpath.
  base: process.env.BASE_PATH || "/",
  plugins: [copyWorkletPlugin()],
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
