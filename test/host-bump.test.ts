/**
 * The nightly bump proposal's rules (`scripts/host-bump.ts`): what the drift
 * report's reading of the registry makes of a channel (data, a range change,
 * a wait, or nothing), and the edits that move CONTRIBUTING's release-step-3
 * data in the files that hold it. The proposal's CLI against a loopback
 * registry is the mock suite's (`test/mock/host-drift-cli.mock.ts`).
 *
 * Every view is read off the records (`test/support/host-drift-fixture.ts`),
 * so the cases keep their meaning across a channel bump; every text is the
 * real file's, so an edit that would miss its line fails here, not in the
 * proposed pull request.
 *
 * @module test/host-bump.test
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import semver from "semver";
import { describe, expect, it } from "vitest";

import { channelManifest } from "../scripts/channel-manifest.ts";
import {
  applyBumpTexts,
  bumpBody,
  bumpPlan,
  type BumpPlan,
  bumpTarget,
  bumpTitle,
  coupleSharedPi,
  README_HELD_FIELDS,
  withReadmePolicy,
  withRecord,
} from "../scripts/host-bump.ts";
import { hostDrift, type RegistryView } from "../scripts/host-drift.ts";
import {
  ALPHA_NEXT,
  declaredBy,
  NEXT_ALPHA,
  nextPrerelease,
  PATCHED,
  registryOf,
  versions,
  withCut,
} from "./support/host-drift-fixture.ts";
import {
  type Channel,
  CHANNELS,
  RECORD_TAGS,
} from "./support/host-versions.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

const peers = (
  JSON.parse(read("package.json")) as {
    peerDependencies: Record<string, string>;
  }
).peerDependencies;

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13, 12);
/** Both the new dsh and pi, published long enough ago to install. */
const SETTLED = { dsh: NOW - 48 * HOUR, pi: NOW - 48 * HOUR };

const plan = (
  channel: Channel,
  registry: RegistryView,
  publishedAt: Readonly<Partial<Record<"dsh" | "pi", number>>> = SETTLED
) =>
  bumpPlan({
    channel,
    now: NOW,
    peers,
    publishedAt,
    record: CHANNELS[channel],
    registry,
    tags: RECORD_TAGS,
  });

/** `view` with alpha's dist-tag moved to `version`, its cluster declaring alpha's ranges. */
const alphaCut = (version: string): RegistryView => {
  const cut = withCut(registryOf(CHANNELS), CHANNELS.alpha, version);
  return {
    ...cut,
    dsh: {
      ...cut.dsh,
      "dist-tags": { alpha: version, [CHANNELS.rc.distTag]: CHANNELS.rc.dsh },
    },
  };
};

/** `view` with one more pi published. */
const withPi = (view: RegistryView, ...more: string[]): RegistryView => ({
  ...view,
  pi: {
    versions: { ...view.pi.versions, ...versions(...more).versions },
  },
});

/** The next pi patch inside both bridges' `^1.x` range. */
const NEXT_PI = semver.inc(CHANNELS.alpha.pi, "patch") ?? "";

/** The registry with the records' dist-tags replaced by `tags`. */
const retagged = (
  view: RegistryView,
  tags: Readonly<Record<string, string>>
): RegistryView => ({ ...view, dsh: { ...view.dsh, "dist-tags": tags } });

/** The rc line's next build published, under `tag` alone. */
const rcCutUnder = (tag: string): RegistryView => {
  const version = nextPrerelease(CHANNELS.rc.dsh);
  return retagged(withCut(registryOf(CHANNELS), CHANNELS.rc, version), {
    [CHANNELS.alpha.distTag]: CHANNELS.alpha.dsh,
    [tag]: version,
  });
};

describe("host bump · the plan", () => {
  it("plans a bump as data, a range change, a wait or nothing, and never from a partial read", () => {
    // (a) The registry is the records: nothing to propose.
    for (const channel of ["alpha", "rc"] as const) {
      const current = plan(channel, registryOf(CHANNELS));
      expect(current.kind, channel).toBe("current");
      expect(current.moved).toStrictEqual([]);
    }

    // (b) The next alpha cut moves dsh and the whole family: data, and the
    // floor cells run on dispatch since a family field moved.
    const next = plan("alpha", ALPHA_NEXT);
    expect(next.kind).toBe("data");
    expect(next.to.dsh).toBe(NEXT_ALPHA.dsh);
    for (const field of [
      "dsh",
      "cordis",
      "cosmokit",
      "group",
      "include",
      "loader",
      "schemastery",
      "timer",
    ] as const) {
      expect(next.moved, field).toContain(field);
      expect(next.to[field], field).toBe(NEXT_ALPHA[field]);
    }
    expect(next.needsFloorCells).toBe(true);
    expect(plan("rc", ALPHA_NEXT).kind).toBe("current");

    // (c) A cut that moves only dsh: no floor cell needed.
    const dshOnly = plan("alpha", alphaCut(NEXT_ALPHA.dsh));
    expect(dshOnly.kind).toBe("data");
    expect(dshOnly.moved).toStrictEqual(["dsh"]);
    expect(dshOnly.needsFloorCells).toBe(false);

    // (d) A cut on a tuple the typert peer range does not admit opens a new
    // prerelease line: a range change, for review.
    const tuple = plan("alpha", alphaCut("0.2.3-alpha.1"));
    expect(tuple.kind).toBe("range");
    const typert = "@deepseek-ai/dsh-typert-protocol";
    expect(tuple.notes.join("\n")).toContain(typert);
    expect(tuple.notes.join("\n")).toContain(peers[typert]);

    // (e) The bridge is not published at the new version: a partial read is
    // never proposed from.
    const partial = alphaCut(NEXT_ALPHA.dsh);
    const blocked = plan("alpha", {
      ...partial,
      bridge: { versions: registryOf(CHANNELS).bridge.versions },
    });
    expect(blocked.kind).toBe("blocked");
    expect(blocked.notes.join("\n")).toContain("is not published");

    // (f) pnpm refuses a version published inside its one-day window, so a
    // cut that young waits a night; one a day old is proposed.
    expect(
      plan("alpha", ALPHA_NEXT, { dsh: NOW - HOUR, pi: NOW - 48 * HOUR }).kind
    ).toBe("waiting");
    expect(
      plan("alpha", ALPHA_NEXT, { dsh: NOW - 25 * HOUR, pi: NOW - 48 * HOUR })
        .kind
    ).toBe("data");
    // An unread publish time is a partial read too.
    expect(plan("alpha", ALPHA_NEXT, {}).kind).toBe("blocked");
  });
});

describe("host bump · pi, the cordis peer and the dist-tag", () => {
  it("a pi patch moves both records as data, with no floor cells, and waits for or blocks on its own publish time", () => {
    expect(NEXT_PI).not.toBe("");
    const view = withPi(registryOf(CHANNELS), NEXT_PI);
    const plans = (["alpha", "rc"] as const).map((channel) =>
      plan(channel, view)
    );
    for (const each of plans) {
      expect(each.kind, each.channel).toBe("data");
      expect(each.moved, each.channel).toStrictEqual(["pi"]);
      expect(each.to.pi, each.channel).toBe(NEXT_PI);
      expect(each.needsFloorCells, each.channel).toBe(false);
    }
    // One headline for the two records, not the same version twice.
    expect(bumpTitle(plans)).toBe(
      `build: bump the alpha and rc harness records to pi ${NEXT_PI}`
    );
    // The pi's own publish time decides: young waits, unread blocks.
    expect(plan("alpha", view, { pi: NOW - HOUR }).kind).toBe("waiting");
    expect(plan("alpha", view, { dsh: NOW - 48 * HOUR }).kind).toBe("blocked");
    expect(plan("alpha", view, { pi: NOW - 25 * HOUR }).kind).toBe("data");

    // A README value both records share moves once both plans apply, as the
    // proposal applies them (`applyBumpTexts`, which the CLI calls: each
    // plan against the other's PROPOSED record), and nothing is left for
    // review. The real READMEs name the pi range, not the resolved pi, so the
    // README here is synthetic; the records and manifest are the real files.
    const marker = "**Support policy.**";
    const text = `${marker} Both channels run pi \`${CHANNELS.alpha.pi}\` today.\n`;
    const texts = {
      manifest: read("package.json"),
      readmes: [{ file: "README.md", marker, text }],
      records: read("test/support/host-versions.ts"),
    };
    const both = applyBumpTexts(texts, plans, CHANNELS);
    expect(both.unresolved).toStrictEqual({ alpha: [], rc: [] });
    expect(both.readmes).toStrictEqual([
      {
        file: "README.md",
        marker,
        text: `${marker} Both channels run pi \`${NEXT_PI}\` today.\n`,
      },
    ]);
    // Both records moved, and alpha's pins with them.
    const [alphaPlan, rcPlan] = plans as [BumpPlan, BumpPlan];
    expect(both.records).toBe(
      withRecord(
        withRecord(texts.records, "alpha", alphaPlan.to),
        "rc",
        rcPlan.to
      )
    );
    expect(both.manifest).toBe(channelManifest(texts.manifest, alphaPlan.to));
    // One plan alone: the other channel's record is the CURRENT one, so the
    // shared sentence is about both, a reviewer's call, and stays. The rc-only
    // plan leaves package.json, which holds alpha's pins, untouched.
    const alphaOnly = applyBumpTexts(texts, [alphaPlan], CHANNELS);
    expect(alphaOnly.unresolved).toStrictEqual({ alpha: ["pi"] });
    expect(alphaOnly.readmes[0]?.text).toBe(text);
    const rcOnly = applyBumpTexts(texts, [rcPlan], CHANNELS);
    expect(rcOnly.unresolved).toStrictEqual({ rc: ["pi"] });
    expect(rcOnly.manifest).toBe(texts.manifest);
    expect(rcOnly.records).toBe(withRecord(texts.records, "rc", rcPlan.to));
  });

  it("a value both channels share and both plans move apart is left for review in both, never rewritten to one channel's", () => {
    // Both bridges move their pi range on one night, to different ranges.
    const apart = {
      alpha: { piFloor: "1.6.0", piRange: "^1.6.0" },
      rc: { piFloor: "1.7.0", piRange: "^1.7.0" },
    } as const;
    expect(CHANNELS.alpha.piRange).toBe(CHANNELS.rc.piRange);
    expect(CHANNELS.alpha.piFloor).toBe(CHANNELS.rc.piFloor);
    const plans = (["alpha", "rc"] as const).map((channel): BumpPlan => ({
      channel,
      from: CHANNELS[channel],
      kind: "range",
      moved: ["piRange", "piFloor"],
      needsFloorCells: true,
      notes: [],
      to: { ...CHANNELS[channel], ...apart[channel] },
    }));
    const readmes = (
      [
        ["README.md", "**Support policy.**"],
        ["README.zh-CN.md", "**支持策略。**"],
      ] as const
    ).map(([file, marker]) => ({ file, marker, text: read(file) }));
    // Known answer: the shared values are in the policy paragraph, so the
    // case below has something it could wrongly rewrite.
    for (const { file, text } of readmes) {
      expect(text, file).toContain(`\`${CHANNELS.alpha.piRange}\``);
    }
    const edited = applyBumpTexts(
      {
        manifest: read("package.json"),
        readmes,
        records: read("test/support/host-versions.ts"),
      },
      plans,
      CHANNELS
    );
    expect(edited.readmes).toStrictEqual(readmes);
    // Every shared value the paragraphs name is left for review, for each
    // channel that moved it.
    const named = (["piRange", "piFloor"] as const).filter((field) =>
      readmes.some(({ text }) => text.includes(`\`${CHANNELS.alpha[field]}\``))
    );
    expect(named).toContain("piRange");
    expect(edited.unresolved).toStrictEqual({ alpha: named, rc: named });
    // The body says the held fields are red until edited, for each channel.
    const body = bumpBody(plans, {
      files: [],
      unresolved: edited.unresolved,
    });
    expect(
      body
        .split("\n")
        .filter(
          (line) =>
            line.startsWith("- `piRange`") &&
            line.endsWith("is red until the sentence is edited.")
        )
    ).toHaveLength(2);
    // Moved apart in the plans' other order, the same answer.
    expect(
      applyBumpTexts(
        {
          manifest: read("package.json"),
          readmes,
          records: read("test/support/host-versions.ts"),
        },
        plans.toReversed(),
        CHANNELS
      ).readmes
    ).toStrictEqual(readmes);
  });

  it("a value the other channel is moving TO is left for review, in either plan order, never rewritten into both sentences", () => {
    // Not shared now: alpha records `^1.5.0`, rc `^1.3.0`; rc moves to
    // alpha's old value while alpha moves on. Once rc's edit lands, the text
    // says `^1.5.0` twice, and alpha's rewrite would claim both.
    const marker = "**Support policy.**";
    const current = {
      alpha: { ...CHANNELS.alpha, piRange: "^1.5.0" },
      rc: { ...CHANNELS.rc, piRange: "^1.3.0" },
    };
    const text = `${marker} alpha admits pi \`^1.5.0\`, rc pi \`^1.3.0\`.\n`;
    const texts = {
      manifest: read("package.json"),
      readmes: [{ file: "README.md", marker, text }],
      records: read("test/support/host-versions.ts"),
    };
    const moves = (rcTo: string) =>
      (
        [
          ["alpha", "^1.6.0"],
          ["rc", rcTo],
        ] as const
      ).map(([channel, piRange]): BumpPlan => ({
        channel,
        from: current[channel],
        kind: "range",
        moved: ["piRange"],
        needsFloorCells: true,
        notes: [],
        to: { ...current[channel], piRange },
      }));
    const plans = moves("^1.5.0");
    const forward = applyBumpTexts(texts, plans, current);
    const backward = applyBumpTexts(texts, plans.toReversed(), current);
    expect(forward.readmes[0]?.text).toBe(
      `${marker} alpha admits pi \`^1.5.0\`, rc pi \`^1.5.0\`.\n`
    );
    expect(backward.readmes).toStrictEqual(forward.readmes);
    expect(forward.unresolved).toStrictEqual({ alpha: ["piRange"], rc: [] });
    expect(backward.unresolved).toStrictEqual(forward.unresolved);
    // Known answer: rc moving anywhere else leaves alpha's value its own, so
    // both are rewritten and nothing is left, in either order.
    const elsewhere = moves("^1.4.0");
    const rewritten = `${marker} alpha admits pi \`^1.6.0\`, rc pi \`^1.4.0\`.\n`;
    for (const order of [elsewhere, elsewhere.toReversed()]) {
      const edited = applyBumpTexts(texts, order, current);
      expect(edited.readmes[0]?.text).toBe(rewritten);
      expect(edited.unresolved).toStrictEqual({ alpha: [], rc: [] });
    }
  });

  it("pi is one value in both lockfiles: a pi move carries every record, or is held", () => {
    const view = withPi(registryOf(CHANNELS), NEXT_PI);
    const settled = plan("rc", view);
    expect(settled.kind).toBe("data");
    expect(settled.moved).toStrictEqual(["pi"]);
    // Alpha's own cut is hours old: alone, alpha waits, and rc proposes pi.
    const young = { dsh: NOW - 3 * HOUR, pi: SETTLED.pi };
    const alphaCutAndPi = withPi(alphaCut(NEXT_ALPHA.dsh), NEXT_PI);
    const waiting = plan("alpha", alphaCutAndPi, young);
    expect(waiting.kind).toBe("waiting");
    expect(waiting.moved).toContain("pi");
    // Coupled, alpha takes the pi move the same night and its dsh waits:
    // both records end at the pi both lockfiles will hold.
    const [alpha, rc] = coupleSharedPi([waiting, settled]) as [
      BumpPlan,
      BumpPlan,
    ];
    expect(rc).toBe(settled);
    expect(alpha.kind).toBe("data");
    expect(alpha.moved).toStrictEqual(["pi"]);
    expect(alpha.to).toStrictEqual({ ...CHANNELS.alpha, pi: NEXT_PI });
    expect(alpha.needsFloorCells).toBe(false);
    expect(alpha.notes.join(" ")).toContain("pi moves with rc");
    expect(alpha.notes.join(" ")).toContain(NEXT_ALPHA.dsh);
    // The mirror: rc waiting on its own cut while alpha moves pi.
    const rcYoung = plan(
      "rc",
      withPi(rcCutUnder(CHANNELS.rc.distTag), NEXT_PI),
      young
    );
    expect(rcYoung.kind).toBe("waiting");
    const mirrored = coupleSharedPi([plan("alpha", view), rcYoung]);
    expect(mirrored.map((each) => [each.kind, each.to.pi])).toStrictEqual([
      ["data", NEXT_PI],
      ["data", NEXT_PI],
    ]);

    // A channel that cannot take it holds the pi move: a partial read ...
    const partial = plan("alpha", view, { dsh: SETTLED.dsh });
    expect(partial.kind).toBe("blocked");
    const heldByPartial = coupleSharedPi([partial, settled]);
    expect(heldByPartial.map((each) => each.kind)).toStrictEqual([
      "blocked",
      "blocked",
    ]);
    expect(heldByPartial[1]?.notes.join(" ")).toMatch(
      /alpha records .* its read was partial/u
    );
    // ... or a channel current at the old pi (its bridge stops short of it).
    const current = plan("alpha", registryOf(CHANNELS));
    expect(current.kind).toBe("current");
    const heldByCurrent = coupleSharedPi([current, settled]);
    expect(heldByCurrent[1]?.kind).toBe("blocked");
    expect(heldByCurrent[1]?.notes.join(" ")).toContain(
      `its read found pi ${CHANNELS.alpha.pi}`
    );
    // Nothing proposed moves pi, so either lockfile's pi stays.
    expect(
      heldByCurrent.filter(
        (each) =>
          (each.kind === "data" || each.kind === "range") &&
          each.moved.includes("pi")
      )
    ).toStrictEqual([]);
    // No plan moves pi: nothing changes. Both moving pi together: left as
    // it is. (A dsh-only proposal NEXT TO a pi mover is the next case's.)
    const dshOnly = plan("alpha", alphaCut(NEXT_ALPHA.dsh));
    expect(coupleSharedPi([dshOnly, plan("rc", registryOf(CHANNELS))])[0]).toBe(
      dshOnly
    );
    const together = [plan("alpha", view), settled];
    expect(coupleSharedPi(together)).toStrictEqual(together);
  });

  it("a pi move is held, and nothing moves pi, when another record cannot end at it: a range that stops short, a dsh-only proposal, two pis, a third channel", () => {
    const view = withPi(registryOf(CHANNELS), NEXT_PI);
    const settled = plan("rc", view);
    expect(settled.kind).toBe("data");
    const young = { dsh: NOW - 3 * HOUR, pi: SETTLED.pi };
    const waiting = plan(
      "alpha",
      withPi(alphaCut(NEXT_ALPHA.dsh), NEXT_PI),
      young
    );
    expect(waiting.kind).toBe("waiting");
    expect(waiting.to.pi).toBe(NEXT_PI);
    /** Proposed plans that would move a lockfile's pi. */
    const piMoves = (plans: readonly BumpPlan[]) =>
      plans.filter(
        (each) =>
          (each.kind === "data" || each.kind === "range") &&
          each.moved.includes("pi")
      );

    // Known answer: alpha's recorded range admits the new pi, so it couples.
    expect(semver.satisfies(NEXT_PI, CHANNELS.alpha.piRange)).toBe(true);
    expect(coupleSharedPi([waiting, settled])[0]?.kind).toBe("data");
    // The waiting channel's RECORDED range (its installed bridge's, which a
    // pi-only move keeps) stops short of the new pi, though its young cut's
    // admits it: a pi-only move would record a pi its own range refuses, so
    // the pi move is held and alpha keeps its wait.
    const bounded = `>=${CHANNELS.alpha.piFloor} <${NEXT_PI}`;
    expect(semver.satisfies(CHANNELS.alpha.pi, bounded)).toBe(true);
    const stopsShort: BumpPlan = {
      ...waiting,
      from: { ...waiting.from, piRange: bounded },
    };
    const heldByRange = coupleSharedPi([stopsShort, settled]);
    expect(heldByRange[0]).toBe(stopsShort);
    expect(heldByRange[1]?.kind).toBe("blocked");
    expect(heldByRange[1]?.notes.join(" ")).toContain(
      `alpha records ${CHANNELS.alpha.pi} and cannot move with it tonight: its recorded pi range ${bounded} does not admit ${NEXT_PI}`
    );
    expect(piMoves(heldByRange)).toStrictEqual([]);

    // A dsh-only proposal next to a pi mover: its record keeps the old pi,
    // so it holds the pi move, and is itself proposed unchanged.
    const dshOnly = plan("alpha", alphaCut(NEXT_ALPHA.dsh));
    expect(dshOnly.kind).toBe("data");
    expect(dshOnly.moved).toStrictEqual(["dsh"]);
    const heldByDsh = coupleSharedPi([dshOnly, settled]);
    expect(heldByDsh[0]).toBe(dshOnly);
    expect(heldByDsh[1]?.kind).toBe("blocked");
    expect(heldByDsh[1]?.notes.join(" ")).toContain(
      `alpha records ${CHANNELS.alpha.pi} and cannot move with it tonight: its proposal does not move pi`
    );
    expect(piMoves(heldByDsh)).toStrictEqual([]);

    // Two movers that resolve different pis: both held.
    const furtherPi = semver.inc(NEXT_PI, "patch") ?? "";
    const rcFurther: BumpPlan = {
      ...settled,
      to: { ...settled.to, pi: furtherPi },
    };
    const apart = coupleSharedPi([plan("alpha", view), rcFurther]);
    expect(apart.map((each) => each.kind)).toStrictEqual([
      "blocked",
      "blocked",
    ]);
    for (const each of apart) {
      expect(each.notes.join(" "), each.channel).toContain(
        `alpha and rc resolve different pis (${NEXT_PI} and ${furtherPi})`
      );
    }

    // A third channel that cannot take the pi holds it: the waiting plan
    // converted beside it goes back to its wait, so nothing moves pi.
    const third: BumpPlan = {
      ...plan("alpha", registryOf(CHANNELS)),
      channel: "third",
    };
    expect(third.kind).toBe("current");
    const heldByThird = coupleSharedPi([waiting, settled, third]);
    expect(heldByThird[0]).toBe(waiting);
    expect(heldByThird[1]?.kind).toBe("blocked");
    expect(heldByThird[1]?.notes.join(" ")).toContain("third records");
    expect(heldByThird[2]).toBe(third);
    expect(piMoves(heldByThird)).toStrictEqual([]);
  });

  it("names a proposal's target by every proposed record in full, not by its title", () => {
    const view = withPi(registryOf(CHANNELS), NEXT_PI);
    const dsh = plan("alpha", alphaCut(NEXT_ALPHA.dsh));
    const dshAndPi = plan("alpha", withPi(alphaCut(NEXT_ALPHA.dsh), NEXT_PI));
    // The title is the dsh headline either way; the target is not.
    expect(bumpTitle([dshAndPi])).toBe(bumpTitle([dsh]));
    expect(bumpTarget([dshAndPi])).not.toBe(bumpTarget([dsh]));
    // One line, an HTML comment, the body's last.
    const target = bumpTarget([dsh, plan("rc", view)]);
    expect(target).toMatch(/^<!-- host-bump-target \{.*\} -->$/u);
    expect(target).not.toContain("\n");
    expect(
      bumpBody([dsh, plan("rc", view)], { files: [], unresolved: {} })
        .split("\n")
        .at(-1)
    ).toBe(target);
    // Order-free, and a plan that is not proposed is no part of it.
    expect(bumpTarget([plan("rc", view), dsh])).toBe(target);
    expect(bumpTarget([dsh, plan("rc", registryOf(CHANNELS))])).toBe(
      bumpTarget([dsh])
    );
    const parsed = JSON.parse(
      target.slice("<!-- host-bump-target ".length, -" -->".length)
    ) as Record<string, Record<string, string>>;
    expect(Object.keys(parsed)).toStrictEqual(["alpha", "rc"]);
    expect(parsed.alpha?.dsh).toBe(NEXT_ALPHA.dsh);
    expect(parsed.rc?.pi).toBe(NEXT_PI);
  });

  it("a bridge that declares a new pi range is a reviewed change that needs the floor cells", () => {
    const range = `^${semver.inc(CHANNELS.alpha.pi, "minor") ?? ""}`;
    const floor = semver.minVersion(range)?.version ?? "";
    const version = nextPrerelease(CHANNELS.alpha.dsh);
    const view = withPi(
      retagged(
        withCut(
          registryOf(CHANNELS),
          { ...CHANNELS.alpha, piRange: range },
          version
        ),
        { alpha: version, [CHANNELS.rc.distTag]: CHANNELS.rc.dsh }
      ),
      floor
    );
    const moved = plan("alpha", view);
    expect(moved.kind).toBe("range");
    for (const field of ["dsh", "piRange", "piFloor", "pi"] as const) {
      expect(moved.moved, field).toContain(field);
    }
    expect(moved.to.piFloor).toBe(floor);
    expect(moved.needsFloorCells).toBe(true);
    expect(moved.notes.join("\n")).toContain("pi range moved");
  });

  it("a cordis cut outside the declared cordis peer is a range change naming that peer", () => {
    const cordis = "4.2.0-alpha.0";
    const declared = peers["@deepseek-ai/cordis"] ?? "";
    expect(semver.satisfies(cordis, declared)).toBe(false);
    const record = { ...CHANNELS.alpha, cordis };
    const version = nextPrerelease(CHANNELS.alpha.dsh);
    const cut = withCut(registryOf(CHANNELS), record, version);
    const view = retagged(
      {
        ...cut,
        cordis: {
          versions: {
            ...cut.cordis.versions,
            ...declaredBy(record).cordis,
          },
        },
      },
      { alpha: version, [CHANNELS.rc.distTag]: CHANNELS.rc.dsh }
    );
    const moved = plan("alpha", view);
    expect(moved.kind).toBe("range");
    expect(moved.moved).toContain("cordis");
    expect(moved.notes.join("\n")).toContain(
      `@deepseek-ai/cordis ${declared} does not admit ${cordis}`
    );
    expect(moved.needsFloorCells).toBe(true);
  });

  it("a dist-tag never moves alone: a tag-only change is current, a dsh move carries its tag, and a tag the record type does not admit is reviewed", () => {
    // `next` retired once `latest` catches up: the build did not move, so
    // the report prints nothing and nothing is proposed.
    const tagOnly = retagged(registryOf(CHANNELS), {
      [CHANNELS.alpha.distTag]: CHANNELS.alpha.dsh,
      latest: CHANNELS.rc.dsh,
    });
    expect(hostDrift({ rc: CHANNELS.rc }, tagOnly)).toStrictEqual([]);
    const still = plan("rc", tagOnly);
    expect(still.kind).toBe("current");
    expect(still.to.distTag).toBe(CHANNELS.rc.distTag);

    // The next rc build under `latest`, `next` gone: data, and the tag moves
    // with the build. The report names the tag in the dsh line's label.
    const underLatest = plan("rc", rcCutUnder("latest"));
    expect(underLatest.kind).toBe("data");
    expect(underLatest.moved).toStrictEqual(["distTag", "dsh"]);
    expect(underLatest.to.distTag).toBe("latest");
    expect(hostDrift({ rc: CHANNELS.rc }, rcCutUnder("latest"))).toContain(
      `rc: @deepseek-ai/dsh@latest is ${underLatest.to.dsh} on the registry; the record says ${CHANNELS.rc.dsh}`
    );

    // Under a tag `ChannelRecord.distTag` does not admit: writing it would
    // fail the type, so it is a reviewed change, named.
    const unknown = plan("rc", rcCutUnder("rc"));
    expect(unknown.kind).toBe("range");
    expect(unknown.to.distTag).toBe("rc");
    expect(unknown.notes.join("\n")).toContain(
      "the newest build sits under the `rc` dist-tag"
    );

    // The README's tag words are prose: a moved tag is left for review,
    // never rewritten.
    for (const [file, marker] of [
      ["README.md", "**Support policy.**"],
      ["README.zh-CN.md", "**支持策略。**"],
    ] as const) {
      const text = read(file);
      const edited = withReadmePolicy(
        text,
        marker,
        CHANNELS.rc,
        { ...CHANNELS.rc, distTag: "latest" },
        { now: CHANNELS.alpha, proposed: CHANNELS.alpha }
      );
      expect(edited.unresolved, file).toStrictEqual(["distTag"]);
      expect(edited.text, file).toBe(text);
    }
  });

  it("the plan is current exactly when the report has no line for the channel", () => {
    const registry = registryOf(CHANNELS);
    const bridge = registry.bridge.versions?.[CHANNELS.rc.dsh];
    const views: RegistryView[] = [
      registry,
      ALPHA_NEXT,
      PATCHED,
      withPi(registry, NEXT_PI),
      rcCutUnder("latest"),
      rcCutUnder("rc"),
      retagged(registry, {
        [CHANNELS.alpha.distTag]: CHANNELS.alpha.dsh,
        latest: CHANNELS.rc.dsh,
      }),
      { appBoot: {}, bridge: {}, cordis: {}, dsh: {}, pi: {} },
      { ...registry, bridge: {} },
      {
        ...registry,
        bridge: {
          versions: { [CHANNELS.rc.dsh]: { ...bridge, dependencies: {} } },
        },
      },
      { ...registry, cordis: {} },
    ];
    let drifted = 0;
    for (const [index, view] of views.entries()) {
      for (const channel of ["alpha", "rc"] as const) {
        const lines = hostDrift({ [channel]: CHANNELS[channel] }, view);
        drifted += lines.length > 0 ? 1 : 0;
        expect(
          plan(channel, view).kind === "current",
          `${index} ${channel}`
        ).toBe(lines.length === 0);
      }
    }
    // Known answer: both outcomes occur, so the equivalence compared something.
    expect(drifted).toBeGreaterThan(0);
    expect(drifted).toBeLessThan(views.length * 2);
  });
});

describe("host bump · the edits", () => {
  const source = read("test/support/host-versions.ts");
  /** The lines of one channel's record block in the source. */
  const block = (text: string, channel: Channel): string => {
    const start = text.indexOf(`  ${channel}: {\n`);
    return text.slice(start, text.indexOf("\n  },", start));
  };

  it("moves exactly release step 3's data in the files that hold it", () => {
    // The record: one line, in the alpha block, and nothing else.
    const moved = withRecord(source, "alpha", {
      ...CHANNELS.alpha,
      dsh: NEXT_ALPHA.dsh,
    });
    const before = source.split("\n");
    const after = moved.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = before.flatMap((line, index) =>
      line === after[index] ? [] : [index]
    );
    expect(changed).toHaveLength(1);
    expect(after[changed[0] ?? 0]).toBe(`    dsh: "${NEXT_ALPHA.dsh}",`);
    expect(block(moved, "alpha")).toContain(NEXT_ALPHA.dsh);
    expect(block(moved, "rc")).toBe(block(source, "rc"));
    expect(withRecord(source, "alpha", CHANNELS.alpha)).toBe(source);
    // A record the edit cannot find a field in is refused, never half-written.
    const missing = source.replace(`    dsh: "${CHANNELS.alpha.dsh}",\n`, "");
    expect(missing).not.toBe(source);
    expect(() =>
      withRecord(missing, "alpha", { ...CHANNELS.alpha, dsh: NEXT_ALPHA.dsh })
    ).toThrow(/dsh/u);

    // The manifest: alpha's exact pins move with the record; pi's range,
    // which is the union of both channels', does not.
    const manifest = read("package.json");
    const next = JSON.parse(channelManifest(manifest, NEXT_ALPHA)) as {
      devDependencies: Record<string, string>;
    };
    const dshPins = Object.entries(next.devDependencies).filter(([name]) =>
      name.startsWith("@deepseek-ai/dsh-")
    );
    expect(dshPins.length).toBeGreaterThan(3);
    for (const [name, pin] of dshPins) {
      expect(pin, name).toBe(NEXT_ALPHA.dsh);
    }
    expect(next.devDependencies["@earendil-works/pi-ai"]).toBe(
      (JSON.parse(manifest) as { devDependencies: Record<string, string> })
        .devDependencies["@earendil-works/pi-ai"]
    );

    // The README pair's "today" sentences.
    for (const [file, marker] of [
      ["README.md", "**Support policy.**"],
      ["README.zh-CN.md", "**支持策略。**"],
    ] as const) {
      const text = read(file);
      const lines = (body: string): [string, string] => {
        const all = body.split("\n");
        const at = all.findIndex((line) => line.startsWith(marker));
        return [
          all[at] ?? "",
          all.slice(at + 1).find((line) => line !== "") ?? "",
        ];
      };
      const to = { ...CHANNELS.alpha, dsh: NEXT_ALPHA.dsh };
      const edited = withReadmePolicy(text, marker, CHANNELS.alpha, to, {
        now: CHANNELS.rc,
        proposed: CHANNELS.rc,
      });
      expect(edited.unresolved, file).toStrictEqual([]);
      const [policy, installs] = lines(edited.text);
      for (const line of [policy, installs]) {
        expect(line, file).toContain(`\`${NEXT_ALPHA.dsh}\``);
        expect(line, file).not.toContain(`\`${CHANNELS.alpha.dsh}\``);
      }
      // A value both channels record is one sentence about both: which half
      // moved is a reviewer's call, so it is left and named.
      const range = withReadmePolicy(
        text,
        marker,
        CHANNELS.alpha,
        { ...CHANNELS.alpha, piRange: "^1.6.0" },
        { now: CHANNELS.rc, proposed: CHANNELS.rc }
      );
      expect(CHANNELS.rc.piRange).toBe(CHANNELS.alpha.piRange);
      expect(range.unresolved, file).toStrictEqual(["piRange"]);
      expect(range.text, file).toBe(text);
    }
  });

  it("titles and describes the proposal as release step 3 does", () => {
    const data = plan("alpha", ALPHA_NEXT);
    const range = plan("alpha", alphaCut("0.2.3-alpha.1"));
    const dshOnly = plan("alpha", alphaCut(NEXT_ALPHA.dsh));
    expect(bumpTitle([data])).toMatch(
      /^build: bump the alpha harness record to /u
    );
    expect(bumpTitle([range])).toMatch(
      /^build: propose .* \(peer range change, needs review\)$/u
    );
    // A 1.x minor at most: no breaking-change marker in either title.
    for (const title of [bumpTitle([data]), bumpTitle([range])]) {
      expect(title).not.toContain("!");
    }

    const body = bumpBody([data], {
      files: ["test/support/host-versions.ts", "package.json"],
      unresolved: { alpha: ["piRange"] },
    });
    for (const table of [
      "WHOLE_CATALOG",
      "PI_GAPS_BY_CELL",
      "PI_AI_DEFAULTS",
    ]) {
      expect(body, table).toContain(table);
    }
    expect(body).toContain(CHANNELS.alpha.dsh);
    expect(body).toContain(NEXT_ALPHA.dsh);
    expect(body).toContain("test/support/host-versions.ts");
    expect(body).toContain("piRange");
    expect(body).toContain("floor cells were dispatched");
    expect(bumpBody([dshOnly], { files: [], unresolved: {} })).not.toContain(
      "floor cells were dispatched"
    );
    expect(bumpBody([range], { files: [], unresolved: {} })).toContain(
      "@deepseek-ai/dsh-typert-protocol"
    );
  });

  it("says which README fields left for review a test turns red, and which nothing reads", () => {
    const rc = plan("rc", rcCutUnder("latest"));
    // A held field: harness-channel is red until the sentence is edited.
    const held = bumpBody([rc], {
      files: [],
      unresolved: { rc: ["piRange"] },
    });
    expect(held).toContain(
      "- `piRange`: `test/harness-channel.test.ts` is red until the sentence is edited."
    );
    expect(held).not.toContain("no test reads this wording");
    // The dist-tag: nothing reads it, so the body promises no red check.
    const tag = bumpBody([rc], { files: [], unresolved: { rc: ["distTag"] } });
    expect(tag).toContain(
      "- `distTag`: no test reads this wording, so nothing turns red; edit the policy and installs paragraphs of both READMEs before merging."
    );
    expect(tag).not.toContain("is red until");
    // Both at once: each named under its own sentence.
    const mixed = bumpBody([rc], {
      files: [],
      unresolved: { rc: ["distTag", "piRange"] },
    });
    expect(mixed).toContain("- `piRange`: `test/harness-channel.test.ts`");
    expect(mixed).toContain("- `distTag`: no test reads");
    // The held list is the one harness-channel loops over (it imports it).
    expect(README_HELD_FIELDS).toStrictEqual(["dsh", "piRange", "piFloor"]);
  });
});
