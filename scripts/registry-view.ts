/**
 * The registry reads the nightly drift report and the bump proposal share:
 * one abbreviated packument per role (`fetchRegistryView`), and the publish
 * times the proposal needs to honour pnpm's release-age window
 * (`fetchPublishTimes`). The rules that read them are pure
 * (`scripts/host-drift.ts`, `scripts/host-bump.ts`).
 *
 * @module scripts/registry-view
 */
import {
  type Packument,
  REGISTRY_PACKAGES,
  type RegistryRole,
  type RegistryView,
} from "./host-drift.ts";

/** A registry base URL without its trailing slashes. */
export const registryBase = (url: string): string => url.replace(/\/+$/u, "");

/** A package's document URL on `registry` (a scope's slash escaped). */
const documentUrl = (registry: string, name: string): string =>
  `${registryBase(registry)}/${name.replace("/", "%2f")}`;

/**
 * One abbreviated packument per role, fetched together.
 *
 * @param registry - the registry's base URL.
 * @returns the view the rules read.
 * @throws {Error} naming the package and the status when any answer is not ok: a
 *   view with a hole in it is never handed to the rules.
 */
export const fetchRegistryView = async (
  registry: string
): Promise<RegistryView> => {
  const packument = async (name: string): Promise<Packument> => {
    const response = await fetch(
      documentUrl(registry, name),
      // The abbreviated form carries dist-tags and each version's dependency
      // ranges, which is all the rules read.
      { headers: { accept: "application/vnd.npm.install-v1+json" } }
    );
    if (!response.ok) {
      throw new Error(`the registry answered ${response.status} for ${name}`);
    }
    return (await response.json()) as Packument;
  };
  const roles = Object.keys(REGISTRY_PACKAGES) as RegistryRole[];
  const answers = await Promise.all(
    roles.map(async (role) => packument(REGISTRY_PACKAGES[role]))
  );
  return Object.fromEntries(
    roles.map((role, index) => [role, answers[index] ?? {}])
  ) as RegistryView;
};

/**
 * When each of `versions` of `name` was published, from the full packument's
 * `time` (the abbreviated one does not carry it).
 *
 * @param registry - the registry's base URL.
 * @param name - the package.
 * @param versions - the versions asked about.
 * @returns epoch milliseconds per version; a version the registry gives no
 *   time for is absent, which the proposal reads as unread.
 */
export const fetchPublishTimes = async (
  registry: string,
  name: string,
  versions: readonly string[]
): Promise<Readonly<Record<string, number>>> => {
  const response = await fetch(documentUrl(registry, name), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`the registry answered ${response.status} for ${name}`);
  }
  const { time } = (await response.json()) as {
    readonly time?: Readonly<Record<string, string>>;
  };
  return Object.fromEntries(
    versions.flatMap((version) => {
      const at = Date.parse(time?.[version] ?? "");
      return Number.isNaN(at) ? [] : [[version, at]];
    })
  );
};
