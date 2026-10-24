/**
 * The entry the deprecated `@viztor/dsh-opencode` wrapper ships.
 *
 * Both its `lib/index.mjs` and its `lib/index.d.mts` are exactly these bytes:
 * `export *` from the canonical package and nothing else. The barrel
 * (`src/index.ts`) has named exports only, so a `default` re-export is an ESM
 * link error the moment the host loads the wrapper — `SyntaxError: The
 * requested module 'dsh-opencode-patch' does not provide an export named
 * 'default'`. The text and the write both live here, so
 * `test/wrapper-forwarder.test.ts` links what `publish-scoped.ts` writes by
 * calling the same function, instead of linking a copy of it.
 *
 * @module scripts/wrapper-forwarder
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

export const WRAPPER_FORWARDER = 'export * from "dsh-opencode-patch";\n';

/**
 * Write the wrapper's two entry files into a `lib/` directory.
 *
 * @param libDir - the wrapper package's `lib/` directory.
 */
export const writeWrapperEntries = (libDir: string): void => {
  writeFileSync(path.join(libDir, "index.mjs"), WRAPPER_FORWARDER);
  writeFileSync(path.join(libDir, "index.d.mts"), WRAPPER_FORWARDER);
};
