/**
 * Presentation data and pure helpers for the OpenCode Go quota meter: geometry,
 * action links, window/breakdown helpers and the stylesheet. Stateless and
 * dependency-free, so meter behavior is unit-testable without React.
 *
 * @module dsh-opencode-patch/usage-ui
 */

import { isRecord } from "./guards.ts";
import type { GoUsage, UsageWindow } from "./usage-contract.ts";

export const RADIUS = 5.5;
export const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Clamp a quota percentage to the ring's range and derive its dash array.
 *
 * Shared by the trigger ring (which strokes `strokeDasharray`) and the panel
 * progress bar (which uses `clampedPercent` as a width), so both render the
 * same number.
 *
 * @param percent - the raw quota percentage; out-of-range values clamp.
 */
export const ringGeometry = (
  percent: number
): { clampedPercent: number; strokeDasharray: string } => {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const dashLength = (CIRCUMFERENCE * clampedPercent) / 100;
  return {
    clampedPercent,
    strokeDasharray: `${dashLength} ${CIRCUMFERENCE}`,
  };
};

/**
 * Where a user acts on what this meter shows. The console is the ONLY place a
 * balance appears: OpenCode exposes no credit endpoint and the payload carries
 * no currency, so no dollar figure can be derived from a percentage.
 * `AGENTS.md` → "OpenCode endpoints" records the probed surface behind that.
 */
export const GO_PLAN_URL = "https://opencode.ai/go";
/**
 * The console, which is also where a pay-as-you-go account is topped up.
 *
 * One URL for both, and deliberately so: it is the only destination verified to
 * exist. Every path under `/console/` answers 200 because the console is a
 * single-page app, so a probe cannot distinguish a real `/billing` route from a
 * catch-all — and a top-up link that 404s in front of a user is worse than one
 * that opens the page where top-up lives.
 */
export const CONSOLE_URL = "https://opencode.ai/console";

/** One action the panel can offer, as data so the two popovers share a body. */
export interface PanelAction {
  href: string;
  labelKey: string;
}

/**
 * What to DO about the quota, rendered inside the GO layer — next to the windows
 * it acts on, not parked under the shared footer.
 *
 * One link, not two. The limits doc went: the panel already names every window
 * with its share and its reset time, so the document explained a list the user
 * is looking at. A link that restates what is on screen is the same redundancy
 * as a card that restates the badge — the doc is one click from the console for
 * anyone who wants the policy.
 *
 * Zen has nothing to add: its single action IS the console on the footer row,
 * labelled 充值 because that is what a pay-as-you-go user wants from it.
 */
export const panelActions = (isZen: boolean): readonly PanelAction[] =>
  isZen ? [] : [{ href: GO_PLAN_URL, labelKey: "usageUpgradePlan" }];

/**
 * Whether a provider route or model id contains any configured marker,
 * case-insensitively. Blank markers never match, so an accidental empty
 * entry cannot reveal the meter everywhere.
 */
export const matchesAny = (
  value: string,
  markers: readonly string[]
): boolean => {
  const lower = value.toLowerCase();
  return markers.some(
    (marker) => marker.length > 0 && lower.includes(marker.toLowerCase())
  );
};

/** Markers for one quota window, driving both the breakdown rows and cards. */
export const BREAKDOWN_WINDOWS: {
  cardName: string;
  key: "monthly" | "rolling" | "weekly";
  labelKey: string;
}[] = [
  { cardName: "5-Hour", key: "rolling", labelKey: "usage_rolling" },
  { cardName: "Weekly", key: "weekly", labelKey: "usage_weekly" },
  { cardName: "Monthly", key: "monthly", labelKey: "usage_monthly" },
];

export const STYLES = `
.dsh-oc-usage-root {
  position: relative;
  display: inline-flex;
  min-width: 0;
  vertical-align: middle;
}

/*
 * The trigger follows the host's own composer pills: a translucent fill rather
 * than a bare glyph on the bar. DSH pairs its ContextMeter ring with a filled
 * pill ("176M tok · 缓存命中 97%"), and an unfilled trigger reads as unfinished
 * next to it.
 */
.dsh-oc-usage-trigger {
  border: 0;
  /*
   * No fill at rest: the composer's own controls are ghost, and a tinted pill
   * beside the model selector reads as a chip with a frame of its own. The hover
   * tint is the affordance — it is what says the ring is a button.
   */
  background: transparent;
  color: var(--dsw-alias-label-secondary, currentColor);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  padding: 3px 9px;
  /* --dsw-radius-md (12px), NOT 999px. The stadium IS a host idiom — it is what
   * Tag, the Switch track, the kit's Pill and the close button all use — but
   * every one of those is a FIXED-height chip, where a pill reads as a pill.
   * On this trigger the radius clamps to half the box, so 999px turns it into
   * the same stadium while the model selector beside it stays a rounded rect:
   * two neighbouring controls, two different corner languages.
   *
   * The reference is the host's own composer control, which pairs the two
   * properties at issue: border-radius var(--dsw-radius-md) with background
   * var(--dsw-alias-interactive-bg-hover) — the fill we already use, so the
   * colour was never wrong and only the radius was. */
  border-radius: var(--dsw-radius-md, 12px);
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background 0.15s ease, color 0.15s ease;
  user-select: none;
}

.dsh-oc-usage-trigger:hover,
.dsh-oc-usage-trigger:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 7%, transparent));
  color: var(--dsw-alias-label-primary, currentColor);
}

.dsh-oc-usage-trigger.dsh-oc-usage-alert {
  color: var(--dsw-alias-state-error-primary);
}

.dsh-oc-usage-ring-track {
  fill: none;
  stroke: currentColor;
  opacity: 0.2;
  stroke-width: 2;
}

.dsh-oc-usage-ring-fill {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  transition: stroke-dasharray 0.3s ease, stroke 0.2s ease;
}

/*
 * Host rules for a floating surface: no border AND an elevation shadow, never
 * both a border and a shadow (docs/web-styling.md), radius from the panel token,
 * background from the menu material so it matches every other popover.
 */
.dsh-oc-usage-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 1100;
  width: 320px;
  max-width: calc(100vw - 24px);
  max-height: 80vh;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 14px 16px;
  border: 0;
  /* --dsw-radius-lg, 16px — which is where this STARTED, before two rounds of
   * "read the host's values" made it worse. The right reference is
   * MenuSurface.module.css, because this panel IS menu material: its .surface and
   * .backing rules take --dsw-radius-lg, and .compact takes --dsw-radius-md.
   * (Braces cannot appear in this comment — the tests extract a rule with a
   * brace-free match, so one here truncates every assertion in this file.)
   *   * The 28px --dsw-radius-panel belongs to the dockkit FLOAT, which is a
   * position:fixed panel docked to the screen edge with an opaque
   * --dsw-alias-bg-layer-2 and no backdrop. Different material, different radius —
   * see the note on choosing the reference. */
  border-radius: var(--dsw-radius-lg, 16px);
  /* The host's own menu material, and the one line that decides whether this
   * reads as part of the harness. --dsw-menu-surface-fill is TRANSLUCENT
   * (#f8f9fa94 light, #43454a73 dark) so the blur behind it shows through.
   *
   * This used to stack --dsw-specific-menu (#f8f9faf0 — 94% opaque) over
   * --dsw-alias-bg-layer-2 (--dsw-static-neutral-bluish-00: #fff, fully
   * opaque). Two real tokens, correct-looking names, and the sum was solid
   * white: the only popover in the composer that did not look like one. The
   * tokens were checked and the RESULT was not — a fallback chain cannot be
   * verified by reading the name. --dsw-specific-menu is the *specific*
   * (higher-emphasis) menu; a plain floating surface wants the surface fill.
   */
  background: var(--dsw-menu-surface-fill, Canvas);
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  /* The stroke is NOT declared here, and never needed to be. Hardcoding one
   * level broke the other theme — which is why the owner's first instinct
   * ("should we use border-l4?") was RIGHT and two rounds of reasoning talked
   * them out of it.
   *
   * The theme picks it per theme, off the attribute the host's own Menu sets:
   *     body                                          -> border-l4
   *     body[data-ds-dark-theme] [data-menu-material] -> border-l3
   * There is NO light-theme [data-menu-material] rule, so l3 is a DARK value
   * that reads like a global one. Grep it without its selector and you get the
   * wrong answer in the light theme — the theme every screenshot here is in.
   * The panel is menu material, so it carries the attribute and takes whatever
   * the theme says; setting the variable here would pin one theme's answer and
   * silently break the other's. */
  /* --dsw-elevation-prominent, and this was briefly "panel" because a token by
   * that name exists. The harness's OWN floating panel — the dockkit float, the
   * same class of thing in this same dock — reads
   *   box-shadow: var(--dsw-elevation-prominent)
   * so prominent is the surface elevation, and elevation-panel is a token nobody
   * consumes. Reverted after reading the consumer instead of the name, which is
   * the mistake this file has now paid for twice. */
  box-shadow: var(--dsw-elevation-prominent, 0 12px 36px rgba(0, 0, 0, 0.28));
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 12px;
  line-height: 1.5;
  isolation: isolate;
  animation: dsh-oc-fade-in 0.15s ease-out;
}

@keyframes dsh-oc-fade-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Header: title left, the one big number right — the host's own popover shape. */
.dsh-oc-usage-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.dsh-oc-usage-headline {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.dsh-oc-usage-breakdown {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 6px;
  /* The windows are quota; the rows below are money. Without this the last
     reset sat flush against the session spend and the two read as one list. */
  margin-bottom: 14px;
}

.dsh-oc-usage-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.dsh-oc-usage-row-left {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, currentColor);
}

/* Tertiary, and never competing with the percent for the right edge. */
.dsh-oc-usage-row-reset {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, currentColor);
}

.dsh-oc-usage-row-right {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, currentColor);
}

/* The bar is the shape the number takes: one track per window, the fill the
   window's own colour. Two pixels — a progress bar that is also a ruler. */
.dsh-oc-usage-bar {
  height: 2px;
  margin-top: 4px;
  margin-left: 13px;
  border-radius: var(--dsw-radius-full, 999px);
  background: var(--dsw-alias-border-l4, currentColor);
  overflow: hidden;
}

.dsh-oc-usage-bar-fill {
  height: 100%;
  border-radius: inherit;
  transition: width 0.3s ease;
}

/* Styling lives in the sheet, not inline: an ad-hoc style prop here would be
   the only one surviving in the panel, and a second limited-state tone tomorrow
   would either duplicate it or diverge from it. */
.dsh-oc-usage-limited {
  margin-left: 6px;
  color: var(--dsw-alias-state-error-primary);
  font-weight: 600;
}

/* The footer carries the timestamp AND every action now. The upgrade-plan link had its own
   row once, behind a divider, which made the panel a row taller and put a second
   action in a second place. Links keep the host's own language — the colour is
   from its MarkdownText stylesheet — because unstyled anchors ran together into
   one sentence. See AGENTS.md, "The meter's panel". */
.dsh-oc-usage-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, currentColor);
  padding-top: 4px;
}

.dsh-oc-usage-console {
  color: var(--dsw-alias-link, currentColor);
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
}

.dsh-oc-usage-console:hover,
.dsh-oc-usage-console:focus-visible {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.dsh-oc-usage-console:focus-visible {
  outline: none;
  border-radius: var(--dsw-radius-xs, 4px);
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

.dsh-oc-usage-updated {
  display: inline-flex;
  align-items: center;
  /* Tight: the button's own 20px box already carries the breathing room, and
     the gap was on top of it. The target stays 20px — padding is not what makes
     this row look empty, and shrinking the hit area to close a gap would trade
     accessibility for a pixel. */
  gap: 1px;
  min-width: 0;
}

.dsh-oc-usage-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin: -4px 0;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, currentColor);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.dsh-oc-usage-refresh:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 10%, transparent));
  color: var(--dsw-alias-label-primary, currentColor);
}

.dsh-oc-usage-refresh:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

/* The control is busy mid-read; the glyph turns rather than disappearing. */
.dsh-oc-usage-refresh:disabled {
  cursor: default;
  opacity: 0.6;
}

.dsh-oc-usage-refresh:disabled .dsh-oc-usage-refresh-icon {
  animation: dsh-oc-spin 0.9s linear infinite;
}

@keyframes dsh-oc-spin {
  to {
    transform: rotate(360deg);
  }
}

.dsh-oc-usage-console {
  color: var(--dsw-alias-link, currentColor);
  font-size: 11px;
  font-weight: 500;
  text-decoration: none;
}

.dsh-oc-usage-console:hover,
.dsh-oc-usage-console:focus-visible {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

/*
 * A failure is the one thing here the user can act on, so unlike every other row
 * it IS a callout — same shape as the overflow notice above, in the error tone.
 * This class rendered with no rule at all until now: a bare <div> with a <p>,
 * which meant UA margins, no colour and no emphasis on the one message that
 * needed it.
 */
.dsh-oc-usage-warning {
  padding: 7px 9px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 1.45;
  margin-top: 8px;
}

.dsh-oc-usage-warning strong {
  font-weight: 600;
}

/* The detail line is a <p>, whose UA margins would double the padding. */
.dsh-oc-usage-warning p {
  margin: 2px 0 0;
  color: var(--dsw-alias-label-secondary, currentColor);
}

.dsh-oc-usage-zen-notice {
  font-size: 11px;
  line-height: 1.45;
  padding: 7px 9px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  margin-top: 4px;
}

/*
 * A detail row — label, sub-label, value. NOT a card: the panel is already a
 * floating surface, and a second background inside it draws two nested frames
 * around one line of text. The row reads as one of the breakdown's own rows,
 * which is what it is.
 */
.dsh-oc-usage-detail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

/* The first detail is spaced by whatever precedes it — the header's own margin
   on Zen, the divider on Go — so only a STACKED one needs a gap of its own. */
.dsh-oc-usage-detail + .dsh-oc-usage-detail {
  margin-top: 10px;
}

.dsh-oc-usage-detail-left {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.dsh-oc-usage-detail-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, currentColor);
}

.dsh-oc-usage-detail-desc {
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, currentColor);
}

/* The info affordance that carries the billing rule: a control, not
   decoration, so it takes the host's label token and says it is hoverable. */
.dsh-oc-usage-info {
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
  color: var(--dsw-alias-label-tertiary, currentColor);
  cursor: help;
  vertical-align: middle;
}

/* Same metrics as a breakdown row's value, so the rows line up as one list. */
.dsh-oc-usage-detail-value {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, currentColor);
  white-space: nowrap;
}
`;

// The stylesheet is rendered as a `<style>` element inside this component's own
// tree (see `ActiveUsage`) instead of being appended to `document.head`: writing
// DOM outside the component leaks a permanent `<style>` node on unmount and is
// disallowed for DSH client plugins.

/**
 * What a window's fill state IS, in the kit's own vocabulary.
 *
 * `StateDotState` — the same union `@deepseek-ai/dsh-client-ui-primitives`'
 * `StateDot` takes — reads `done` / `warning` / `error`, and its CSS maps each
 * to the exact `--dsw-alias-state-*` token this file used to inline. Returning
 * the SEMANTIC instead of a colour string is what let the window rows adopt the
 * kit's dot: a hand-rolled 6px circle with an inline `backgroundColor` per
 * state was one more look-alike of a primitive this repo already ships.
 *
 * The ring and the bar keep reading COLOURS off these names (they are strokes
 * and fills, not dots), so the token map below stays the single place the
 * percentage ladder is written down.
 */
export type WindowState = "done" | "warning" | "error";

export const getWindowState = (window: UsageWindow): WindowState => {
  if (window.status === "rate-limited" || window.percent >= 100) {
    return "error";
  }
  if (window.percent >= 80) {
    return "warning";
  }
  return "done";
};

/** The state ladder as colours, for strokes and fills the kit does not ship. */
export const WINDOW_STATE_COLOR: Record<WindowState, string> = {
  done: "var(--dsw-alias-state-success-primary)",
  warning: "var(--dsw-alias-state-warn-primary)",
  error: "var(--dsw-alias-state-error-primary)",
};

export const getWindowColor = (window: UsageWindow): string =>
  WINDOW_STATE_COLOR[getWindowState(window)];

/**
 * The ring colour before a window exists — `done`, the neutral assumption;
 * the ring refills the moment data lands.
 */
export const getWindowColorFor = (affecting?: AffectingWindowResult): string =>
  affecting === undefined
    ? WINDOW_STATE_COLOR.done
    : getWindowColor(affecting.window);

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
    ? { d: "天", h: "小时", m: "分" }
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

export interface AffectingWindowResult {
  key: "monthly" | "rolling" | "weekly";
  label: string;
  window: UsageWindow;
}

/** Whether a window is OUT: the vendor says so, or it is at the cap. */
const isExhausted = (window: UsageWindow): boolean =>
  window.status === "rate-limited" || window.percent >= 100;

export const getAffectingWindow = (usage: GoUsage): AffectingWindowResult => {
  // 1. A window that is OUT is what the reader has to see, widest first: a
  //    monthly cap explains a refusal that the 5-hour window does not.
  if (isExhausted(usage.monthly)) {
    return { key: "monthly", label: "Monthly", window: usage.monthly };
  }
  if (isExhausted(usage.weekly)) {
    return { key: "weekly", label: "Weekly", window: usage.weekly };
  }
  if (isExhausted(usage.rolling)) {
    return { key: "rolling", label: "5-Hour", window: usage.rolling };
  }

  // 2. Otherwise the 5-HOUR window, which resets soonest and so is the one the
  //    reader can still act on. Picking the HIGHEST percentage made the meter
  //    answer for the weekly window (33%) while the 5-hour window (11%) was the
  //    live constraint — read as "why is it showing the weekly limit?".
  return { key: "rolling", label: "5-Hour", window: usage.rolling };
};

/**
 * Whether a provider route is OpenCode Zen rather than Go.
 *
 * Both routes share the `opencode` prefix, so the distinguishing signal is
 * the presence of `go`: `opencode-go` is the subscription plan, plain
 * `opencode` is Zen pay-as-you-go.
 */
export const isZenProvider = (provider?: string): boolean => {
  if (typeof provider !== "string") {
    return false;
  }
  const lower = provider.toLowerCase();
  return lower.includes("opencode") && !lower.includes("go");
};

/**
 * The localized copy the meter's header, badge and Zen card render.
 *
 * No tooltip line lives here: the trigger's hover explanation used to be a
 * second composition off the same inputs, and that seam was the wrong place to
 * hang two new keys an older dictionary had never heard of — they rendered raw
 * the first boot a user took the new bundle with an old locale registration.
 * The tooltip is `headline` until that API earns its own contract.
 */
export interface UsageCopy {
  badgeText: string;
  /**
   * What the panel header names: the ACCOUNT, not its state.
   *
   * `OpenCode Go` beside `Go Plan` / the limit badge, exactly as `OpenCode Zen`
   * sits beside `Pay-as-you-go`. The header used to carry `headline` — the
   * ring's own figure — which made the one line that identifies the surface
   * change every poll: it read `42% of Weekly used`, then `Monthly quota
   * limited`. Both facts are already on screen (the badge, and each window's
   * own row), so the line that should be stable was the one that moved.
   */
  title: string;
  /**
   * The ring explained in words — what the GO trigger says on hover.
   *
   * It names the bottleneck window ("90% of Weekly used"). It is a sentence
   * ABOUT A RING, which is why it cannot also be the Zen trigger's label: the
   * Zen trigger shows session spend and has no ring, and binding it to this
   * string is what made the hover say nothing but the account name.
   */
  headline: string;
  /**
   * The trigger's hover label, per provider.
   *
   * A tooltip has to MEAN the number beside it. Go's number is a ring, so
   * `headline` explains it. Zen's number is session spend, and the question that
   * raises is "is this metered?" — answered here once, in words, rather than by
   * repeating the panel header (which is `title`, and is already on screen).
   */
  tooltip: string;
  zenCardCredit: string;
  zenCardDesc: string;
}

/**
 * Derive the meter's user-facing copy from the active reading.
 *
 * Pure: the component owns state, this owns wording. `t` is the bound
 * translator; `affecting` is the bottleneck window (or `undefined` while the
 * first read is in flight).
 */
export const describeUsage = (
  _usage: GoUsage | undefined,
  affecting: AffectingWindowResult | undefined,
  isZen: boolean,
  t: (key: string) => string
): UsageCopy => {
  const isLimited = affecting?.window.status === "rate-limited";
  const percent = affecting?.window.percent ?? 0;

  const title = isZen ? t("zenPaygTitle") : t("goPlanTitle");

  const headline = isLimited
    ? `${affecting?.label} quota limited`
    : `${percent}% of ${affecting?.label ?? "quota"} used`;

  // The trigger's hover label. Go's number IS a ring, so the headline explains
  // it; Zen's number is session spend, which asks a different question —
  // "is this metered?" — and gets the one honest answer we have.
  const tooltip = isZen ? t("zenPaygTooltip") : headline;

  let badgeText: string;
  if (isZen) {
    badgeText = t("zenPaygBadge");
  } else if (isLimited) {
    badgeText = t("usageLimited");
  } else {
    // Nothing. The header already reads `OpenCode Go`, so a `Go Plan` chip
    // beside it repeats the title and adds no fact — the same test every row in
    // this panel has to pass. The chip still appears for `Limited`, where it
    // says something the title does not.
    badgeText = "";
  }

  // The Zen card renders on a GO route with overflow only (`usage-panel.tsx`),
  // so these two have exactly the two states that card can be in: the plan is
  // limited and the overflow is live, or the plan is fine and the balance is
  // standing by. A Zen route never reaches them — there the badge already says
  // pay-as-you-go, and OpenCode has no balance endpoint to report.
  const zenCardDesc = isLimited
    ? t("zenFallbackNotice")
    : t("zenOverflowActive");
  const zenCardCredit = isLimited ? "Active" : "Ready";

  return { badgeText, headline, title, tooltip, zenCardCredit, zenCardDesc };
};

/**
 * A failed usage read, normalized from whatever the Host remote threw.
 *
 * `configured === false` is the "no credential at all" state: a configuration
 * fact rather than a fault, which the meter renders as nothing instead of an
 * unavailable state the user cannot act on.
 */
export interface UsageFailure {
  configured?: boolean;
  message?: string;
  retainPrevious: boolean;
  /** Why the read failed; `auth` is a rejected credential, not an outage. */
  reason?: string;
  source?: string;
}

/** Normalize a Host remote rejection into a {@link UsageFailure}. */
export const parseFailure = (error: unknown): UsageFailure => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "opencode-go/usage-unavailable"
  ) {
    const details =
      "details" in error && isRecord(error.details) ? error.details : {};
    return {
      ...(details.configured === false ? { configured: false } : {}),
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : undefined,
      reason: typeof details.reason === "string" ? details.reason : undefined,
      retainPrevious:
        details.retryable === true && details.retainPrevious === true,
      source: typeof details.source === "string" ? details.source : undefined,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    retainPrevious: false,
  };
};
