/**
 * The retired alias's forwarder, in one place.
 *
 * **The wrapper re-exports the canonical package's NAMES, and nothing else.**
 * It used to add `export { default } from "dsh-opencode-patch";` — and the
 * canonical package has no `default` export, so every load of the wrapper was a
 * link error:
 *
 * ```
 * SyntaxError: The requested module 'dsh-opencode-patch'
 *   does not provide an export named 'default'
 * ```
 *
 * That is a hard failure before any of the plugin runs: the alias is a
 * published package, and the thing it exists for — letting an existing install
 * keep resolving — is exactly what it prevented.
 *
 * The re-export lives here rather than inline in the publish script because it
 * is written to TWO files (the runtime entry and the type declaration), and
 * the two must not drift: a `.d.mts` that re-exports a name the package does
 * not have is a type error for every consumer, and one that differs from the
 * runtime entry is a lie in the declarations.
 *
 * @module scripts/wrapper-forwarder
 */

/** The package the wrapper forwards to. */
export const FORWARDED_PACKAGE = "dsh-opencode-patch";

/**
 * The forwarder's source, for the runtime entry and the type declaration.
 *
 * `export *` and nothing else: a star re-export carries whatever names the
 * target has, so it cannot name one it does not.
 */
export const wrapperForwarder = (): string =>
  `export * from "${FORWARDED_PACKAGE}";`;
