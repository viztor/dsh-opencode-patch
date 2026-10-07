/**
 * Keep the OpenCode console credential in DSH's store fresh.
 *
 * OpenCode's console no longer issues a long-lived `sk-…` API key for Go or Zen.
 * It issues a **console session** instead: an `st_…` access token (30 days) plus
 * an `rt_…` refresh token, and the org's remote config points every provider at
 * it —
 *
 * ```json
 * "provider": { "opencode-go": { "api": "https://opencode.ai/inference/go/openai/v1",
 *                               "options": { "apiKey": "{env:OPENCODE_CONSOLE_TOKEN}",
 *                                            "headers": { "x-opencode-org-id": "wrk_…" } } } }
 * ```
 *
 * The CLI mints that token into its own `process.env` on every boot and never
 * writes it to `auth.json`, so anything outside the CLI — this plugin included —
 * sees a credential that silently ages out. This script is how it stays current.
 *
 * Three facts shape the implementation, each measured against the live console:
 *
 * 1. **The refresh token ROTATES.** Every exchange returns a new `rt_`, and the
 *    old one stops working. So a refresh that is not written back to
 *    `opencode.db` breaks the CLI's *next* refresh — the script must persist the
 *    pair, not just use it.
 * 2. **Freshness is knowable.** `token_expiry` is stored in the row, so the
 *    common case is a no-op: nothing is exchanged until the token is genuinely
 *    close to expiry, which keeps rotation (and therefore CLI interference) rare.
 * 3. **The credentials file is hand-maintained YAML.** It is edited by line, not
 *    round-tripped through a YAML parser, so comments, ordering and every other
 *    ref survive byte-for-byte. It is backed up first, and replaced atomically.
 *
 * ```sh
 * node --experimental-strip-types scripts/refresh-opencode-token.ts             # refresh if stale
 * node --experimental-strip-types scripts/refresh-opencode-token.ts --force     # refresh now
 * node --experimental-strip-types scripts/refresh-opencode-token.ts --dry-run   # report only
 * ```
 *
 * It never prints a secret — only a prefix, a length and a digest prefix, which
 * is enough to tell "the same token" from "a rotated one" without leaking one.
 *
 * A note on concurrency: the CLI and this script share one refresh token, so a
 * refresh racing the CLI's own could strand one of them. The window is small and
 * the failure is a re-login, but it is the reason this defaults to refreshing
 * only when the token is nearly expired rather than on every run.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The client id the CLI itself sends; the console keys its grants on it. */
const CLIENT_ID = "opencode-cli";

/** Refresh when less than this remains, so a token is never used mid-expiry. */
const DEFAULT_SKEW_MS = 24 * 60 * 60 * 1000;

/** The ref this script exists for; `--ref` may name others. */
const DEFAULT_REF = "OPENCODE_GO_API_KEY";

type Options = {
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly refs: readonly string[];
  readonly skewMs: number;
  readonly dbPath: string;
  readonly credentialsPath: string;
};

type AccountRow = {
  readonly id: string;
  readonly url: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenExpiry: number | null;
  readonly orgId: string | null;
};

type Tokens = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
};

/**
 * Describe a secret without disclosing it.
 *
 * A digest is what makes "did this rotate?" answerable in a log line while the
 * value itself stays out of it — a prefix alone cannot distinguish a rotation.
 *
 * @param value - the secret to describe.
 * @returns a prefix, length and digest prefix.
 */
const fingerprint = (value: string): string =>
  `${value.slice(0, 6)}… len=${value.length} sha=${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;

/**
 * Parse the command line.
 *
 * @param argv - arguments after the script name.
 * @returns the resolved options.
 */
const parseArgs = (argv: readonly string[]): Options => {
  const dataDir =
    process.env["OPENCODE_DATA_DIR"] ??
    join(homedir(), ".local", "share", "opencode");
  const options = {
    force: false,
    dryRun: false,
    refs: [] as string[],
    skewMs: DEFAULT_SKEW_MS,
    dbPath: join(dataDir, "opencode.db"),
    credentialsPath:
      process.env["OPENCODE_CREDENTIALS_FILE"] ??
      join(homedir(), ".dsh", ".credentials.yaml"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--ref") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--ref needs a name");
      options.refs.push(value);
      index += 1;
    } else if (arg === "--skew-hours") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0)
        throw new Error("--skew-hours needs a number");
      options.skewMs = value * 60 * 60 * 1000;
      index += 1;
    } else if (arg === "--db") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--db needs a path");
      options.dbPath = value;
      index += 1;
    } else if (arg === "--credentials") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--credentials needs a path");
      options.credentialsPath = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.refs.length === 0) options.refs.push(DEFAULT_REF);
  return options;
};

/**
 * Read the active console account out of the CLI's database.
 *
 * Read-only: the row is needed even when nothing is refreshed, and opening a
 * database another process is actively writing to should not imply a lock.
 *
 * @param dbPath - path to `opencode.db`.
 * @returns the active account, or `undefined` when none is signed in.
 */
const readAccount = (dbPath: string): AccountRow | undefined => {
  if (!existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "select a.id, a.url, a.access_token, a.refresh_token, a.token_expiry, s.active_org_id " +
          "from account a join account_state s on s.active_account_id = a.id"
      )
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      id: String(row["id"]),
      url: String(row["url"]),
      accessToken: String(row["access_token"]),
      refreshToken: String(row["refresh_token"]),
      tokenExpiry:
        row["token_expiry"] === null ? null : Number(row["token_expiry"]),
      orgId:
        row["active_org_id"] === null ? null : String(row["active_org_id"]),
    };
  } finally {
    db.close();
  }
};

/**
 * Decide whether the stored access token still has useful life.
 *
 * @param expiry - epoch milliseconds, or `null` when the row never recorded one.
 * @param now - current epoch milliseconds.
 * @param skewMs - how much life must remain to count as fresh.
 * @returns true when the token can be used without refreshing.
 */
const isFresh = (expiry: number | null, now: number, skewMs: number): boolean =>
  expiry !== null && expiry > now + skewMs;

/**
 * Exchange the refresh token for a new pair.
 *
 * @param consoleUrl - the account's console origin.
 * @param refreshToken - the current refresh token.
 * @returns the minted pair.
 */
const refreshTokens = async (
  consoleUrl: string,
  refreshToken: string
): Promise<Tokens> => {
  const response = await fetch(
    `${consoleUrl.replace(/\/+$/u, "")}/auth/device/token`,
    {
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    }
  );

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null
        ? JSON.stringify(body)
        : "<no body>";
    throw new Error(`refresh failed: HTTP ${response.status} ${detail}`);
  }
  if (typeof body !== "object" || body === null)
    throw new Error("refresh failed: unreadable body");

  const record = body as Record<string, unknown>;
  const accessToken = record["access_token"];
  const nextRefresh = record["refresh_token"];
  const expiresIn = record["expires_in"];
  if (typeof accessToken !== "string" || typeof nextRefresh !== "string") {
    throw new Error("refresh failed: response carried no token pair");
  }

  return {
    accessToken,
    refreshToken: nextRefresh,
    expiresInSeconds: typeof expiresIn === "number" ? expiresIn : 2_592_000,
  };
};

/**
 * Write the rotated pair back so the CLI keeps working.
 *
 * This is not a convenience: the refresh token rotates, so skipping the write
 * would leave the database holding a token the console has already retired, and
 * the CLI's next refresh would fail.
 *
 * @param dbPath - path to `opencode.db`.
 * @param accountId - the row to update.
 * @param tokens - the minted pair.
 * @param now - current epoch milliseconds.
 */
const persistTokens = (
  dbPath: string,
  accountId: string,
  tokens: Tokens,
  now: number
): void => {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("pragma busy_timeout = 30000");
    db.prepare(
      "update account set access_token = ?, refresh_token = ?, token_expiry = ?, time_updated = ? where id = ?"
    ).run(
      tokens.accessToken,
      tokens.refreshToken,
      now + tokens.expiresInSeconds * 1000,
      now,
      accountId
    );
  } finally {
    db.close();
  }
};

/**
 * Replace one ref's value inside the credentials file's `refs:` block.
 *
 * Line-based on purpose. Parsing and re-emitting the YAML would reformat a file
 * this script does not own, and a single mis-serialised sibling ref would take
 * the whole store down with it.
 *
 * @param text - the file's current contents.
 * @param ref - the ref name to set.
 * @param value - the new value.
 * @returns the updated text, or `undefined` when the ref is not declared.
 */
const setRefValue = (
  text: string,
  ref: string,
  value: string
): string | undefined => {
  const pattern = new RegExp(`^(\\s{2}${ref}:[ \\t]*)(.*)$`, "mu");
  if (!pattern.test(text)) return undefined;
  const safe = /^[\w.-]+$/u.test(value) ? value : JSON.stringify(value);
  return text.replace(pattern, (_match, prefix: string) => `${prefix}${safe}`);
};

/**
 * Replace the credentials file atomically, after keeping a copy.
 *
 * @param path - the file to write.
 * @param text - its new contents.
 * @param stamp - a suffix for the backup name.
 */
const writeCredentials = (path: string, text: string, stamp: string): void => {
  copyFileSync(path, `${path}.bak-${stamp}`);
  const temporary = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
};

/**
 * Refresh the console token when it needs it, and mirror it into DSH's store.
 */
const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const now = Date.now();

  const account = readAccount(options.dbPath);
  if (account === undefined) {
    throw new Error(
      `no active console account in ${options.dbPath} — run \`opencode console login\``
    );
  }

  const fresh = isFresh(account.tokenExpiry, now, options.skewMs);
  const remaining =
    account.tokenExpiry === null
      ? "unknown"
      : `${((account.tokenExpiry - now) / 3_600_000).toFixed(1)}h`;
  process.stdout.write(
    `account   ${account.id}\n` +
      `org       ${account.orgId ?? "<none>"}\n` +
      `token     ${fingerprint(account.accessToken)}\n` +
      `expires   ${remaining} remaining (skew ${options.skewMs / 3_600_000}h)\n`
  );

  if (fresh && !options.force) {
    process.stdout.write("status    fresh — nothing to do\n");
    return;
  }
  if (options.dryRun) {
    process.stdout.write(
      "status    stale — would refresh (dry run, nothing written)\n"
    );
    return;
  }

  const tokens = await refreshTokens(account.url, account.refreshToken);
  process.stdout.write(
    `refreshed ${fingerprint(tokens.accessToken)}\n` +
      `rotated   refresh ${fingerprint(account.refreshToken)} -> ${fingerprint(tokens.refreshToken)}\n`
  );

  persistTokens(options.dbPath, account.id, tokens, now);
  process.stdout.write("persisted opencode.db\n");

  if (!existsSync(options.credentialsPath)) {
    throw new Error(`credentials file not found: ${options.credentialsPath}`);
  }
  const original = readFileSync(options.credentialsPath, "utf8");
  let updated = original;
  for (const ref of options.refs) {
    const next = setRefValue(updated, ref, tokens.accessToken);
    if (next === undefined) {
      process.stdout.write(
        `skipped   ${ref} — not declared in the credentials file\n`
      );
      continue;
    }
    updated = next;
    process.stdout.write(`updated   ${ref}\n`);
  }

  if (updated === original) {
    process.stdout.write("status    credentials file unchanged\n");
    return;
  }
  writeCredentials(
    options.credentialsPath,
    updated,
    new Date(now).toISOString().replace(/[:.]/gu, "-")
  );
  process.stdout.write(`wrote     ${options.credentialsPath} (backup kept)\n`);
};

await main();
