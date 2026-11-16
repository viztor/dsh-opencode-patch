/**
 * The OpenCode Go quota meter's reset countdown: a reset instant in the
 * reader's own language, as a duration or a date, and the label that wraps it.
 * Pure and dependency-free: the clock and the translator are parameters.
 *
 * @module dsh-opencode-patch/usage-time
 */

/**
 * One instant in the reader's own language.
 *
 * `Intl.DateTimeFormat` renders zh's time as `08:55` — CLDR's zh time pattern is
 * `HH:mm` — but a Chinese sentence writes `8点55分`. So for zh the platform's own
 * PARTS are reused and only the hour/minute separator is localized: the
 * month/day literals (`11`, `月`, `7`, `日`) come out of the formatter untouched,
 * and the leading zero comes off the hour because 点 takes the bare number.
 * English keeps the platform's whole assembled string.
 */
const absoluteText = (locale: string | undefined, target: Date): string => {
  const format = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    month: "short",
  });
  if (locale?.startsWith("zh") !== true) {
    return format.format(target);
  }
  const parts = format.formatToParts(target);
  const hourIndex = parts.findIndex((part) => part.type === "hour");
  const head = parts
    .slice(0, hourIndex)
    .map((part) => part.value)
    .join("")
    .trim();
  const value = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${head}${value("hour").replace(/^0/, "")}点${value("minute")}分`;
};

/** The engine's own duration formatter (ES2025; this project's lib is ES2024). */
type DurationFormatCtor = new (
  locale?: string,
  options?: { style?: string }
) => { format: (value: unknown) => string };

/** Whether a value is that constructor. A predicate, so no assertion is needed. */
const isDurationFormatCtor = (value: unknown): value is DurationFormatCtor =>
  typeof value === "function";

/**
 * A reset countdown, tagged with the SHAPE it took.
 *
 * The tag exists because the two shapes compose with DIFFERENT grammar and the
 * panel cannot tell them apart from the text alone. A duration reads as a
 * suffix — `1h 11m后重置` / `1h 11m until reset` — while an absolute date reads
 * as a prefix: `重置于 11月7日 08:55` / `Resets Nov 7, 08:55 AM`. One copy key
 * serving both could only ever be right for one of them, and `重置于 1h 11m`
 * literally reads "resets at 1h 11m".
 */
export interface RelativeReset {
  kind: "duration" | "underMinute" | "absolute" | "passed";
  text: string;
}

/**
 * One duration in the reader's own language.
 *
 * `Intl.DurationFormat` is the platform's built-in for this and is used whenever
 * the engine ships it — Chrome 129+, Safari 18.4+, Firefox 139+, Node 24+. The
 * `narrow` style is what a quota row wants: `1h 11m` in en and `1小时11分钟` in
 * zh, with each locale's own unit words, ordering and pluralisation. The
 * alternative was a hand-rolled unit table, which is a second formatter and a
 * second set of translation decisions.
 *
 * The fallback exists because a missing API must not blank the row, and it is
 * deliberately a unit TABLE rather than a second formatter: same composition,
 * two words per language.
 */
const durationText = (
  locale: string | undefined,
  parts: { days?: number; hours?: number; minutes?: number }
): string => {
  // Read off `Intl` through a GUARD, not an assertion. The constructor is
  // ES2025 and this project's `lib` is ES2024, so the type is ours to name — but
  // naming it is not the same as asserting it, and the engine either ships the
  // function or it does not.
  const candidate: unknown = Reflect.get(Intl, "DurationFormat");
  if (isDurationFormatCtor(candidate)) {
    try {
      return new candidate(locale, { style: "narrow" }).format(parts);
    } catch {
      // An engine that rejects the locale must fall through, not blank the row.
    }
  }
  const zh = locale?.startsWith("zh") === true;
  const units = zh
    ? // `分钟`, not `分`: the platform's narrow zh output, so a row reads the
      // same on an engine without the constructor as on one with it.
      { d: "天", h: "小时", m: "分钟" }
    : { d: "d", h: "h", m: "m" };
  const out: string[] = [];
  if (parts.days !== undefined && parts.days > 0) {
    out.push(`${parts.days}${units.d}`);
  }
  if (parts.hours !== undefined && parts.hours > 0) {
    out.push(`${parts.hours}${units.h}`);
  }
  if (parts.minutes !== undefined && parts.minutes > 0) {
    out.push(`${parts.minutes}${units.m}`);
  }
  return out.join(zh ? "" : " ");
};

export const formatRelativeReset = (
  dateStr: string,
  locale?: string
): RelativeReset => {
  const target = Date.parse(dateStr);
  if (!Number.isFinite(target)) {
    // Unparseable input is handed back verbatim rather than thrown away; the
    // `absolute` shape is what composes a prefix with an opaque value.
    return { kind: "absolute", text: dateStr };
  }
  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    // The window already rolled over. This is REACHABLE in normal operation:
    // the panel re-derives at every render from a payload up to a poll old, so
    // for as long as a minute after a boundary the old `resetsAt` is in the
    // past. Saying `<1m` there is a lie in the same shape as the fabricated
    // rows this panel already removed — a countdown for a reset that happened.
    return { kind: "passed", text: "" };
  }
  // FLOOR, never round: this is a countdown, and it must not claim more time
  // than remains. `Math.round` on the total turned 1h10m36s into `1h 11m`,
  // 59m59s into `1h`, and pulled a 6d23h window off the relative ladder ~20s
  // early — while the day branch truncated minutes. One policy, floored.
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    // The sub-minute case for a POSITIVE diff. Guarding only `diffMs <= 0` left
    // 1-29s rounding to the string `0m`. Its WORDING is copy rather than a
    // duration — no locale formats "under a minute" as a number of minutes —
    // so it carries its own kind and `resetLabel` supplies the text.
    return { kind: "underMinute", text: "" };
  }
  if (diffMinutes < 60) {
    return {
      kind: "duration",
      text: durationText(locale, { minutes: diffMinutes }),
    };
  }
  const diffHours = Math.floor(diffMinutes / 60);
  const remMinutes = diffMinutes % 60;
  if (diffHours < 24) {
    return {
      kind: "duration",
      text: durationText(locale, {
        hours: diffHours,
        ...(remMinutes > 0 ? { minutes: remMinutes } : {}),
      }),
    };
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    const remHours = diffHours % 24;
    // Same zero guard the hour branch above already applies, so exactly two
    // days reads `2天` / `2d` rather than `2天0小时`.
    return {
      kind: "duration",
      text: durationText(locale, {
        days: diffDays,
        ...(remHours > 0 ? { hours: remHours } : {}),
      }),
    };
  }
  return { kind: "absolute", text: absoluteText(locale, new Date(target)) };
};

/**
 * Compose one reset countdown into a single localised line.
 *
 * The three shapes take two different grammars, which is why the formatter
 * reports its kind instead of returning a bare string:
 *
 * - duration — a SUFFIX, because the unit is Latin and the label is not:
 *   `1h 11m后重置` / `1h 11m until reset`.
 * - absolute — a prefix AND a suffix, because the two languages disagree about
 *   where the word goes: `Resets Nov 7, 8:55 AM` puts it first, `11月7日8点55分重置`
 *   puts it last. Both halves live in the dictionary and one of them is empty per
 *   locale.
 * - passed — the window already rolled over, so there is no countdown to give.
 *
 * One prefix for all three produced `重置于 1h 11m`, which reads "resets at
 * 1h 11m" — a sentence no window was ever in.
 */
export const resetLabel = (
  reset: RelativeReset,
  t: (key: ResetCopyKey) => string
): string => {
  if (reset.kind === "duration" || reset.kind === "underMinute") {
    const text =
      reset.kind === "underMinute" ? t("usageResetUnderMinute") : reset.text;
    return `${text}${t("usageResetsIn")}`;
  }
  if (reset.kind === "passed") {
    return t("usageResetPassed");
  }
  return `${t("usageResetsAtPrefix")}${reset.text}${t("usageResetsAtSuffix")}`;
};

/** The copy keys {@link resetLabel} composes, so a rename cannot drift. */
export type ResetCopyKey =
  | "usageResetsAtPrefix"
  | "usageResetsAtSuffix"
  | "usageResetsIn"
  | "usageResetPassed"
  | "usageResetUnderMinute";
