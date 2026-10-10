# Credentials: the pool, the login, and the rotation

The plugin's default is the deployment's own credential: whatever `apiKeyEnv` the profile already declares keeps resolving exactly as it does today. The pool described here is an OPT-IN layer over that, and the opt-in is a switch, not a side effect of adding an entry. A user who logs in with OAuth has taken an action; the plugin still does nothing different until they also say "use the plugin's credentials for these routes."

## The resolution chain

1. **The pool** — only when the user enabled it. Round-robin within the route's plane, skipping entries marked failed; an empty or fully-failed pool falls through rather than erroring.
2. **The declared reference** — `apiKeyEnv` inherited from the profile's own route declaration, resolved through the credentials service with the launch environment as fallback. This is the zero-configuration default and the behavior when the switch is off.
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

## Status

The chain above is the design, measured end to end against OpenCode's own implementation. The code is not built yet; the bridge currently in flight (Google models through the plugin's own adapter) uses step 2 only and introduces no switch, because it needs none.
