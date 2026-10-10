# Credentials: the pool, the login, and the rotation

The plugin's default is the deployment's own credential: whatever `apiKeyEnv` the profile already declares keeps resolving exactly as it does today. The pool is a SEPARATE credential the deployment opts into by pointing a route at it, and nothing about that happens as a side effect of adding an entry. A user who logs in with OAuth has taken an action; the plugin still resolves exactly what the profile names until the profile names the pool's reference.

## The resolution chain

One reference resolves per route, and the pool only enters the picture when the route names the pool's reference:

1. **The route's `apiKeyEnv`** — the reference the deployment declared, resolved through the credentials service with the launch environment as fallback. This is the zero-configuration default, and the whole behavior for a deployment that declares nothing else.
2. **The pool's reference** — the same resolution, for a deployment that named `OPENCODE_POOL_KEY` or `OPENCODE_GO_POOL_KEY` instead. The value behind it is the pool's current key, which the plugin rotates; the wrapper and this plugin both read it per operation, so a rotation reaches the next call without a restart.
3. **Nothing** — a named reference that misses fails loud. Never hand pi an `undefined` for a named ref: it would pick up an unrelated ambient key (`OPENAI_API_KEY` and friends) and bill another tenant.

## The pools are per plane

Zen credentials serve Zen calls, Go credentials serve Go calls, and never the other way: the planes are different accounts with different keys, different endpoints and different catalogs. Each pool holds any mix of:

| Entry    | Origin                                                 | Refresh |
| :------- | :----------------------------------------------------- | :------ |
| API key  | pasted in the plugin's settings, or the environment    | none    |
| OAuth v2 | `auth login opencode` — the provider credential path   | yes     |
| OAuth v1 | `console login` — the account path, with org switching | yes     |

## What the logins are (measured from OpenCode's own source)

Both are device flows against the same Console, differing in what they store and what they unlock:

- `POST {console}/auth/device/code` with `client_id: "opencode-cli"` returns a `device_code`, a `user_code` and a `verification_uri_complete`.
- Polling `POST {console}/auth/device/token` with the device grant returns the `access_token`, `refresh_token` and `expires_in`.
- The refresh grant against the same endpoint returns a NEW refresh token with every access token — the stored pair must be replaced atomically, or the next refresh uses a token the server has already rotated away.
- `GET {console}/api/config` — the authoritative per-account model and price catalog — answers to a plain API key, so the pool does not gate it.

v1 (`console login`) additionally reads `/api/user` and `/api/orgs`, stores the account and org context, and can switch among them; v2 (`auth login opencode`) stores the provider credential with org metadata but no switching. The plugin implements the flows itself, from those measured endpoints, and stores the results in its own settings — never in the CLI's `auth.json`, which belongs to a program the plugin does not own.

## What the pool never touches

- **The `google` route name.** A real deployment may configure Google AI Studio under that id; the plugin's internal route is named `opencode-google` precisely so that name stays free.
- **The CLI's `auth.json`.** Reading it couples the plugin to another program's private file format; writing it collides with the program that owns it.
- **Silent rotation.** Adding a credential changes nothing until the switch is on. This is the contract: zero configuration by default, opt-in by statement.

## The reference the pool owns

The pool does not write behind anyone's key. Writing the user's own reference (`OPENCODE_API_KEY`) is dead on both sides: if nothing shadows it, the write replaces the credential the deployment declared, and if the environment satisfies it, the write is shadowed. The seam refuses that second case out loud — `set` "rejects while a read-only source shadows the reference", because the write would otherwise appear to succeed while resolution kept returning the shadowing value. So the failure is not merely impolite; it is already guarded.

The pool owns a reference of its own instead:

- A dedicated name per plane — `OPENCODE_POOL_KEY`, `OPENCODE_GO_POOL_KEY` — which nothing shadows, so it is writable.
- Rotation writes the next key with `set(ref, value)`, and every route that names that reference resolves it on its next operation, because the seam resolves per call. That includes the routes the wrapper serves: it reads whatever reference the profile declares, so pointing a route at the pool's reference is the whole opt-in.
- Opting in is therefore a configuration statement, which is what the contract in this file asks for. A deployment that leaves `apiKeyEnv` alone keeps the environment's credential and the pool never runs.

What this does not need: a takeover, a record another plugin owns, or any write to a reference the deployment declared. It needs one fresh reference name and the seam's own write path.

## Verified, not assumed

Run against the real `dsh-credentials-local` provider on a temporary document, so the measurement never touched a real `~/.dsh/.credentials.yaml`:

| Claim | Result |
| :-- | :-- |
| a fresh reference is writable | `set` then `resolve` returns the value, `source=file`; `describe` reports `configured` and `writable` |
| rotation reaches the next operation | a second `set` makes the next `resolve` return the NEW value, with no restart |
| the deployment's own reference is protected | writing a name the launching environment supplies is REFUSED: "is supplied read-only by the launching environment, so set would be shadowed" |
| `unset` returns to unconfigured | yes |
| the store is the document the routes resolve from | the written file is `version: 1` with a `refs:` map — the same shape `~/.dsh/.credentials.yaml` already has |

The third row is the one that matters most: the objection that a pool would overwrite the deployment's key is not merely avoided by this design, it is enforced by the implementation.

## Status

The chain above is the design, measured end to end against OpenCode's own implementation and against the credential seam. The code is not built yet. The first piece worth building is the pool's own reference and the rotation behind it — the logins in the sections above are the second, and they are what fill the pool in the first place. The chain above is the design, measured end to end against OpenCode's own implementation. The code is not built yet, and the reach above says what building it buys today: rotation for the bridge route, and for any route a deployment points at this plugin's own adapter. The bridge itself uses step 2 only and introduces no switch, because it needs none.
