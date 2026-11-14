/**
 * The pure half of `scripts/propose-host-bump.ts`: what the nightly makes of
 * a channel that moved, and the edits that move CONTRIBUTING's release-step-3
 * data in the files that hold it (D22'').
 *
 * - **The plan** (`bumpPlan`) reads the same findings the drift report prints
 *   (`readChannel`), so the two never disagree about what moved: a plan is
 *   `current` exactly when the report has no line for the channel. The
 *   dist-tag is the one field the report never prints alone, so it is never
 *   a move alone either: it moves with `dsh` or not at all. The plan decides:
 *   `current` (nothing moved), `blocked` (any answer unread: a proposal is
 *   never made from a partial read), `waiting` (the new `dsh` or pi is younger
 *   than pnpm's one-day release-age window, so an install would refuse it; the
 *   next night proposes it, and nothing lifts the window), `range` (the cut
 *   opens a prerelease tuple the peer ranges do not admit, moves the
 *   bridge's pi range, or sits under a dist-tag the record type does not
 *   admit: a reviewed change), or `data`.
 * - **pi is one value** (`coupleSharedPi`): both lockfiles hold the same pi
 *   (the rc relock starts from the root's), and each record's `pi` must equal
 *   its lockfile's. So a proposed pi move carries every other channel's
 *   record with it: a channel waiting only on its own young `dsh` takes a
 *   pi-only move the same night when its recorded pi range admits the pi,
 *   and one that cannot take it (a partial read, another pi, a recorded
 *   range that stops short) holds the pi move as `blocked` rather than
 *   proposing a record the lockfile, or its own range, contradicts.
 * - **The edits** move version data only: the channel's record
 *   (`withRecord`), the README pair's "today" sentences (`withReadmePolicy`),
 *   and, through the existing `channelManifest`, alpha's exact pins. A
 *   measured table (`WHOLE_CATALOG`, `PI_GAPS_BY_CELL`, `PI_AI_DEFAULTS`,
 *   `s0PluginFor`) is never edited here: a row the new host turns red is the
 *   reviewed part of the proposed pull request, which the body names.
 *
 * Every function is a function of its arguments (`test/host-bump.test.ts`).
 *
 * @module scripts/host-bump
 */
import semver from "semver";

import { channelManifest } from "./channel-manifest.ts";
import {
  BUMP_FIELDS,
  type BumpField,
  type DriftRecord,
  FAMILY_DECLARERS,
  readChannel,
  REGISTRY_PACKAGES,
  type RegistryView,
} from "./host-drift.ts";

/** pnpm's default `minimumReleaseAge`: a day, in milliseconds. */
export const RELEASE_AGE_MS = 24 * 60 * 60 * 1000;

/** The peer each moved field has to stay inside, by package. */
const PEERS = {
  cordis: "@deepseek-ai/cordis",
  dsh: "@deepseek-ai/dsh-typert-protocol",
} as const;

/** The family fields: moving any of them needs the floor cells. */
const FAMILY_FIELDS: ReadonlySet<BumpField> = new Set(
  FAMILY_DECLARERS.map(({ field }) => field)
);

/** What the nightly makes of one channel. */
export interface BumpPlan {
  readonly channel: string;
  /** The record as it stands. */
  readonly from: DriftRecord;
  readonly kind: "blocked" | "current" | "data" | "range" | "waiting";
  /** The fields that moved, in the report's order. */
  readonly moved: readonly BumpField[];
  /**
   * Whether the bump moves `piFloor` or a cordis-family field: a pull request
   * runs only the default installs, so the floor cells run on a dispatch.
   */
  readonly needsFloorCells: boolean;
  /** Why the plan is what it is, one sentence each. */
  readonly notes: readonly string[];
  /** The record the bump proposes: the old one with every moved field set. */
  readonly to: DriftRecord;
}

/**
 * Plan one channel's bump.
 *
 * @param input.channel - the channel's name.
 * @param input.record - its record.
 * @param input.registry - the registry view.
 * @param input.peers - `package.json`'s `peerDependencies`.
 * @param input.publishedAt - when the new `dsh` and pi were published (epoch
 *   ms); an absent time for a field that moved is an unread answer.
 * @param input.now - the clock, in epoch ms.
 * @param input.tags - the dist-tags the record type admits (`RECORD_TAGS`).
 * @returns the plan.
 */
export const bumpPlan = ({
  channel,
  now,
  peers,
  publishedAt,
  record,
  registry,
  tags,
}: {
  readonly channel: string;
  readonly now: number;
  readonly peers: Readonly<Record<string, string>>;
  readonly publishedAt: Readonly<Partial<Record<"dsh" | "pi", number>>>;
  readonly record: DriftRecord;
  readonly registry: RegistryView;
  readonly tags: readonly string[];
}): BumpPlan => {
  const findings = readChannel(record, registry);
  const found = new Map<BumpField, string>();
  const unread: string[] = [];
  for (const finding of findings) {
    if (finding.kind === "unread") {
      unread.push(finding.message);
    } else {
      found.set(finding.field, finding.found);
    }
  }
  for (const field of BUMP_FIELDS) {
    if (unread.length === 0 && !found.has(field)) {
      unread.push(`${field} was not read`);
    }
  }
  const differs = (field: BumpField): boolean =>
    found.has(field) && found.get(field) !== record[field];
  // The dist-tag is carried with a dsh move, never moved alone: the report
  // names it only in the dsh line's label, so a tag-only change (`next`
  // retired once `latest` catches up) is "current" there and here.
  const moved = BUMP_FIELDS.filter(
    (field) => differs(field) && (field !== "distTag" || differs("dsh"))
  );
  const to: DriftRecord = {
    ...record,
    ...(Object.fromEntries(
      moved.map((field) => [field, found.get(field) ?? record[field]])
    ) as Partial<Record<BumpField, string>>),
  };
  const plan = (
    kind: BumpPlan["kind"],
    notes: readonly string[]
  ): BumpPlan => ({
    channel,
    from: record,
    kind,
    moved,
    needsFloorCells: moved.some(
      (field) => field === "piFloor" || FAMILY_FIELDS.has(field)
    ),
    notes,
    to,
  });

  if (unread.length > 0) {
    return plan("blocked", unread);
  }
  if (moved.length === 0) {
    return plan("current", []);
  }

  const young: string[] = [];
  const unknown: string[] = [];
  for (const [role, field] of [
    ["dsh", "dsh"],
    ["pi", "pi"],
  ] as const) {
    if (!moved.includes(field)) continue;
    const at = publishedAt[role];
    const name = REGISTRY_PACKAGES[role];
    if (at === undefined) {
      unknown.push(`the publish time of ${name}@${to[field]} was not read`);
    } else if (now - at < RELEASE_AGE_MS) {
      young.push(
        `${name}@${to[field]} was published ${Math.floor((now - at) / 3_600_000)}h ago, inside pnpm's one-day release-age window; the nightly proposes it once it is a day old`
      );
    }
  }
  if (unknown.length > 0) {
    return plan("blocked", unknown);
  }
  if (young.length > 0) {
    return plan("waiting", young);
  }

  const range: string[] = [];
  for (const [field, peer] of Object.entries(PEERS) as [
    keyof typeof PEERS,
    string,
  ][]) {
    const declared = peers[peer];
    if (
      moved.includes(field) &&
      declared !== undefined &&
      !semver.satisfies(to[field], declared)
    ) {
      const tuple = `${semver.major(to[field])}.${semver.minor(to[field])}.${semver.patch(to[field])}`;
      range.push(
        `${peer} ${declared} does not admit ${to[field]}: the cut opens the ${tuple} prerelease tuple, so add a \`>=${tuple}-0\` clause (with the upper bound the other clauses use) and the new line to the README pair's peer-range paragraph`
      );
    }
  }
  if (moved.includes("distTag") && !tags.includes(to.distTag)) {
    range.push(
      `the newest build sits under the \`${to.distTag}\` dist-tag, which the record type does not admit (${tags.map((tag) => `\`${tag}\``).join(", ")}): add it to \`ChannelRecord.distTag\` in review`
    );
  }
  if (moved.includes("piRange")) {
    range.push(
      `the bridge's pi range moved from ${record.piRange} to ${to.piRange}: the plugin's own pi range and the union rule follow it in review`
    );
  }
  return range.length > 0 ? plan("range", range) : plan("data", []);
};

/**
 * `test/support/host-versions.ts` with one channel's record moved to `to`:
 * only that block's literal fields change, everything else is kept byte for
 * byte.
 *
 * @param source - the file's text.
 * @param channel - the record to move.
 * @param to - the proposed record.
 * @returns the edited text.
 * @throws {Error} unless every field a bump moves is found exactly once in the block,
 *   so an edit that could miss its line is refused rather than half-written.
 */
export const withRecord = (
  source: string,
  channel: string,
  to: Readonly<Record<BumpField, string>>
): string => {
  const records = source.indexOf("export const CHANNELS");
  const opening = `\n  ${channel}: {\n`;
  const start = source.indexOf(opening, records);
  const end = source.indexOf("\n  },", start);
  if (records === -1 || start === -1 || end === -1) {
    throw new Error(`no ${channel} record in the CHANNELS block`);
  }
  let block = source.slice(start, end);
  for (const field of BUMP_FIELDS) {
    const line = new RegExp(`^( +${field}: )"([^"]*)",$`, "gmu");
    const matches = [...block.matchAll(line)];
    if (matches.length !== 1) {
      throw new Error(
        `the ${channel} record carries ${matches.length} ${field} line(s), not one`
      );
    }
    block = block.replaceAll(line, `$1${JSON.stringify(to[field])},`);
  }
  return `${source.slice(0, start)}${block}${source.slice(end)}`;
};

/**
 * One README's support-policy paragraph and the installs paragraph after it,
 * with a channel's moved values replaced where they appear in backticks.
 *
 * A value the other channel records too (both say pi `^1.3.0`) is one
 * sentence about both: it is rewritten only when the other channel's
 * proposed record moves it to the SAME new value. When the other channel
 * keeps it, or moves it somewhere else, which half says what is a reviewer's
 * call: it is left as it is and returned in `unresolved`, and the proposed
 * pull request names it. A value the other channel is moving TO is left the
 * same way, since after that channel's edit the text no longer says whose it
 * is. For a field in {@link README_HELD_FIELDS} the pull request is then red
 * in `test/harness-channel.test.ts` until a reviewer edits the sentence; for
 * any other field nothing reads the wording, and the body says so. A moved
 * dist-tag is never rewritten either: the tag words in those paragraphs are
 * prose about both lines (`next` ahead of `latest`), so it is left for review
 * the same way whenever the old tag appears, and no test holds it (the rc
 * paragraph names `latest` in backticks whichever tag the record carries).
 *
 * @param text - the README.
 * @param marker - the policy paragraph's opening (`**Support policy.**`).
 * @param from - the channel's record now.
 * @param to - the record the bump proposes.
 * @param other.now - the other channel's record now.
 * @param other.proposed - the other channel's record as the bump proposes it
 *   (`now` when that channel is not part of the bump).
 * @returns the edited text, and the fields left for review.
 */
export const withReadmePolicy = (
  text: string,
  marker: string,
  from: Readonly<Record<BumpField, string>>,
  to: Readonly<Record<BumpField, string>>,
  other: {
    readonly now: Readonly<Record<BumpField, string>>;
    readonly proposed: Readonly<Record<BumpField, string>>;
  }
): { readonly text: string; readonly unresolved: readonly BumpField[] } => {
  const lines = text.split("\n");
  const policy = lines.findIndex((line) => line.startsWith(marker));
  if (policy === -1) {
    throw new Error(`no ${marker} paragraph`);
  }
  const offset = lines.slice(policy + 1).findIndex((line) => line !== "");
  const edited = offset === -1 ? [policy] : [policy, policy + 1 + offset];
  const unresolved: BumpField[] = [];
  for (const field of BUMP_FIELDS) {
    if (from[field] === to[field]) continue;
    const old = `\`${from[field]}\``;
    if (!edited.some((index) => lines[index]?.includes(old) === true)) {
      continue;
    }
    const shared = other.now[field] === from[field];
    if (
      field === "distTag" ||
      other.proposed[field] === from[field] ||
      (shared && other.proposed[field] !== to[field])
    ) {
      unresolved.push(field);
      continue;
    }
    for (const index of edited) {
      lines[index] = (lines[index] ?? "").replaceAll(old, `\`${to[field]}\``);
    }
  }
  return { text: lines.join("\n"), unresolved };
};

/**
 * The record fields `test/harness-channel.test.ts` holds both READMEs'
 * policy paragraph to (it reads this list): a README value of one of these
 * left for review turns the proposal red until a reviewer edits it.
 */
export const README_HELD_FIELDS = ["dsh", "piRange", "piFloor"] as const;

/** A README the bump edits: its path, its policy marker and its text. */
export interface BumpReadme {
  readonly file: string;
  readonly marker: string;
  readonly text: string;
}

/**
 * The text half of a proposal: every plan applied to the records file, to
 * `package.json` (alpha's pins, when alpha moves) and to each README, with
 * the README fields left for review merged per channel. Each plan's README
 * edit is checked against the OTHER channel's record now and as the bump
 * PROPOSES it (the current one when that channel is not part of the bump),
 * so a value both channels share is rewritten only when both plans move it
 * to the same value, and left for review when one plan moves it alone or the
 * two move it apart. The CLI writes what this returns and runs the installs;
 * it holds no edit of its own.
 *
 * @param texts.records - `test/support/host-versions.ts`.
 * @param texts.manifest - `package.json`.
 * @param texts.readmes - the README pair.
 * @param plans - the plans to propose (`data` and `range`).
 * @param current - every channel's record now, by channel.
 * @returns the edited texts and the fields left for review, per channel.
 */
export const applyBumpTexts = (
  texts: {
    readonly manifest: string;
    readonly readmes: readonly BumpReadme[];
    readonly records: string;
  },
  plans: readonly BumpPlan[],
  current: Readonly<Record<string, Readonly<Record<BumpField, string>>>>
): {
  readonly manifest: string;
  readonly readmes: readonly BumpReadme[];
  readonly records: string;
  readonly unresolved: Readonly<Record<string, readonly BumpField[]>>;
} => {
  let { records } = texts;
  for (const each of plans) {
    records = withRecord(records, each.channel, each.to);
  }
  const alpha = plans.find((each) => each.channel === "alpha");
  const manifest =
    alpha === undefined
      ? texts.manifest
      : channelManifest(texts.manifest, alpha.to);
  const now = (channel: string): Readonly<Record<BumpField, string>> => {
    const record = current[channel];
    if (record === undefined) {
      throw new Error(`no ${channel} record`);
    }
    return record;
  };
  const after = (channel: string): Readonly<Record<BumpField, string>> =>
    plans.find((each) => each.channel === channel)?.to ?? now(channel);
  const unresolved: Record<string, BumpField[]> = {};
  const readmes = texts.readmes.map((readme) => {
    let { text } = readme;
    for (const each of plans) {
      const other =
        Object.keys(current).find((channel) => channel !== each.channel) ??
        each.channel;
      const edited = withReadmePolicy(text, readme.marker, each.from, each.to, {
        now: now(other),
        proposed: after(other),
      });
      ({ text } = edited);
      unresolved[each.channel] = [
        ...new Set([...(unresolved[each.channel] ?? []), ...edited.unresolved]),
      ];
    }
    return { ...readme, text };
  });
  return { manifest, readmes, records, unresolved };
};

/** `a`, `a and b`, `a, b and c`. */
const listed = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

/** Whether a plan is one the nightly proposes. */
const proposes = (plan: BumpPlan): boolean =>
  plan.kind === "data" || plan.kind === "range";

/**
 * The plans with pi treated as the one value it is. Both lockfiles hold the
 * same pi (the rc relock starts from the root lockfile, and the proposer's
 * `pnpm update` moves the root's), and `test/harness-channel.test.ts` holds
 * each record's `pi` to its lockfile's. So when a proposed plan moves pi,
 * every other channel's record has to end at the same pi:
 *
 * - one that already records it is left as it is;
 * - one `waiting` only on its own young cut, whose read found the same new
 *   pi and whose RECORDED pi range (the range its installed bridge declares,
 *   which the pi-only move keeps) admits it, takes a pi-only `data` move the
 *   same night (pi's publish time is the proposed plan's, already past the
 *   window), and its other moves wait;
 * - any other (a partial read, a channel current at another pi, a waiting
 *   channel whose recorded range stops short of the pi, a proposed plan
 *   that does not move pi, two proposed plans that disagree) cannot: every
 *   proposed plan that moves pi is then `blocked`, with a note naming the
 *   channel, a waiting plan is returned as it was (never converted), and
 *   nothing moves either lockfile's pi.
 *
 * A plan that moves no pi is returned as it is, so a dsh-only proposal is
 * never held by another channel's pi; it holds THEIR pi move instead, since
 * its record would keep the old pi.
 *
 * @param plans - every channel's plan, in the channels' order.
 * @returns the plans in the same order, coupled.
 */
export const coupleSharedPi = (plans: readonly BumpPlan[]): BumpPlan[] => {
  const movers = plans.filter(
    (plan) => proposes(plan) && plan.moved.includes("pi")
  );
  if (movers.length === 0) {
    return [...plans];
  }
  const targets = [...new Set(movers.map((plan) => plan.to.pi))];
  const [target = ""] = targets;
  const names = listed(movers.map((plan) => plan.channel));
  const coupled: BumpPlan[] = [];
  const holds: string[] =
    targets.length > 1
      ? [
          `${names} resolve different pis (${listed(targets)}), and both lockfiles hold one: the pi move is held for review`,
        ]
      : [];
  /** Each waiting plan converted to a pi-only move, by the converted plan. */
  const converted = new Map<BumpPlan, BumpPlan>();
  for (const plan of plans) {
    const waitsOnTarget =
      plan.kind === "waiting" &&
      plan.moved.includes("pi") &&
      plan.to.pi === target;
    if (movers.includes(plan) || plan.from.pi === target) {
      coupled.push(plan);
    } else if (waitsOnTarget && semver.satisfies(target, plan.from.piRange)) {
      const move: BumpPlan = {
        ...plan,
        kind: "data",
        moved: ["pi"],
        needsFloorCells: false,
        notes: [
          `pi moves with ${names}, since both lockfiles hold one pi; ${plan.channel}'s other moves wait: ${plan.notes.join("; ")}`,
        ],
        to: { ...plan.from, pi: target },
      };
      converted.set(move, plan);
      coupled.push(move);
    } else {
      let why = `its read found pi ${plan.to.pi}`;
      if (plan.kind === "blocked") {
        why = `its read was partial (${plan.notes.join("; ")})`;
      } else if (proposes(plan)) {
        why = "its proposal does not move pi";
      } else if (waitsOnTarget) {
        why = `its recorded pi range ${plan.from.piRange} does not admit ${target}`;
      }
      holds.push(
        `pi ${target} is one value in both lockfiles, and ${plan.channel} records ${plan.from.pi} and cannot move with it tonight: ${why}; the pi move is held until every record can take it`
      );
      coupled.push(plan);
    }
  }
  if (holds.length === 0) {
    return coupled;
  }
  // Held: every mover is blocked, and a plan converted above goes back to
  // the wait it was, so nothing moves pi.
  return coupled.map((plan) =>
    movers.includes(plan)
      ? { ...plan, kind: "blocked", notes: [...holds, ...plan.notes] }
      : (converted.get(plan) ?? plan)
  );
};

/**
 * What a proposal proposes, in full: each proposed channel's `to` record,
 * every bump field, in an HTML comment the body carries. The push step
 * compares it with the open pull request's body to decide "the same
 * target"; the title cannot, since it names only each plan's headline value
 * (a pi that moves after a dsh cut leaves it unchanged).
 *
 * @param plans - the plans (`data` and `range` only are read).
 * @returns the marker line.
 */
export const bumpTarget = (plans: readonly BumpPlan[]): string => {
  const target = Object.fromEntries(
    plans
      .filter(proposes)
      .toSorted((a, b) => a.channel.localeCompare(b.channel))
      .map((plan) => [
        plan.channel,
        Object.fromEntries(BUMP_FIELDS.map((field) => [field, plan.to[field]])),
      ])
  );
  return `<!-- host-bump-target ${JSON.stringify(target)} -->`;
};

/** The headline value of a plan: its dsh when that moved, else its pi. */
const headline = (plan: BumpPlan): string => {
  if (plan.moved.includes("dsh")) {
    return plan.to.dsh;
  }
  if (plan.moved.includes("pi")) {
    return `pi ${plan.to.pi}`;
  }
  return plan.moved.map((field) => `${field} ${plan.to[field]}`).join(", ");
};

/**
 * The proposal's title, a Conventional Commit of type `build` (a 1.x change
 * either way, never a breaking marker): a data bump names the records it
 * moves, and a range change says it needs review.
 *
 * @param plans - the plans to propose (`data` and `range` only are read).
 * @returns the title.
 */
export const bumpTitle = (plans: readonly BumpPlan[]): string => {
  // Both records move together on a pi patch: one headline, not two equal.
  const headlines = (list: readonly BumpPlan[]): string =>
    listed([...new Set(list.map(headline))]);
  const range = plans.filter((plan) => plan.kind === "range");
  if (range.length > 0) {
    return `build: propose ${REGISTRY_PACKAGES.dsh} ${headlines(range)} for ${listed(range.map((plan) => plan.channel))} (peer range change, needs review)`;
  }
  const data = plans.filter((plan) => plan.kind === "data");
  return `build: bump the ${listed(data.map((plan) => plan.channel))} harness record${data.length === 1 ? "" : "s"} to ${headlines(data)}`;
};

/**
 * The body's paragraph on README fields left for review: which a test holds
 * (red until edited) and which nothing reads (the reviewer's alone).
 */
const leftForReview = (fields: readonly BumpField[]): string[] => {
  if (fields.length === 0) {
    return [];
  }
  const code = (list: readonly string[]): string =>
    list.map((field) => `\`${field}\``).join(", ");
  const held = fields.filter((field) =>
    (README_HELD_FIELDS as readonly string[]).includes(field)
  );
  const unheld = fields.filter((field) => !held.includes(field));
  return [
    "",
    `Left for review in both READMEs (a value the other channel records too, or a dist-tag, whose sentences are prose about both lines): ${code(fields)}.`,
    ...(held.length === 0
      ? []
      : [
          `- ${code(held)}: \`test/harness-channel.test.ts\` is red until the sentence is edited.`,
        ]),
    ...(unheld.length === 0
      ? []
      : [
          `- ${code(unheld)}: no test reads this wording, so nothing turns red; edit the policy and installs paragraphs of both READMEs before merging.`,
        ]),
  ];
};

/**
 * The proposal's body: per channel what moved, the files the bump changed,
 * what was left for review, what CONTRIBUTING's release step 3 asks to
 * re-measure when a tier turns red, and whether the floor cells run.
 *
 * @param plans - the plans to propose.
 * @param effects.files - the files the proposal wrote.
 * @param effects.unresolved - README fields left for review, per channel.
 * @returns the markdown.
 */
export const bumpBody = (
  plans: readonly BumpPlan[],
  {
    files,
    unresolved,
  }: {
    readonly files: readonly string[];
    readonly unresolved: Readonly<Record<string, readonly BumpField[]>>;
  }
): string => {
  const proposed = plans.filter(proposes);
  const sections = proposed.map((plan) => {
    const rows = plan.moved.map(
      (field) =>
        `| \`${field}\` | \`${plan.from[field]}\` | \`${plan.to[field]}\` |`
    );
    return [
      `### ${plan.channel}${plan.kind === "range" ? " (peer range change)" : ""}`,
      "",
      "| field | was | proposed |",
      "| :-- | :-- | :-- |",
      ...rows,
      ...(plan.notes.length === 0
        ? []
        : ["", ...plan.notes.map((note) => `- ${note}`)]),
      ...leftForReview(unresolved[plan.channel] ?? []),
    ].join("\n");
  });
  const floor = proposed.some((plan) => plan.needsFloorCells);
  return [
    "The nightly `host-drift` job found the harness channels moved past their records and proposes CONTRIBUTING's release-step-3 data. Generated by CI: nothing here is a measured table.",
    "",
    ...sections.flatMap((section) => [section, ""]),
    "**Files moved:**",
    "",
    ...(files.length === 0 ? ["- none"] : files.map((file) => `- \`${file}\``)),
    "",
    "**If a tier or the binary e2e goes red**, the host behaves differently, and the re-measure is the reviewed part of this pull request, never edited by the nightly: a pi whose catalog or bases moved re-measures the `newest` cell's column of `WHOLE_CATALOG` (`test/host-shapes.test.ts`) and of `PI_GAPS_BY_CELL` (`test/support/host.ts`); a moved `piFloor`, the floor's columns of the same two; a bridge whose defaults moved, `PI_AI_DEFAULTS`, which feeds `s0PluginFor`; a host event whose call shape moved, the route claim's listener (`src/host/route-claim.ts`) and the tier listeners.",
    "",
    floor
      ? "A floor-cell field moved (`piFloor` or the cordis family), and a pull request runs only the default installs: the floor cells were dispatched on `chore/host-bump` (ci.yml, `workflow_dispatch`)."
      : "No floor-cell field moved: the floor cells were not dispatched, and this pull request's own CI is the whole run.",
    "",
    bumpTarget(proposed),
  ].join("\n");
};
