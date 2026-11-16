/**
 * The OpenCode Go quota meter's stylesheet, as one string the meter renders in
 * a `<style>` element of its own tree. Dependency-free, so a test can read the
 * rules without React.
 *
 * @module dsh-opencode-patch/usage-css
 */

export const STYLES = `
.dsh-oc-usage-root {
  position: relative;
  display: inline-flex;
  min-width: 0;
  vertical-align: middle;
  /* The trigger carries side padding for its hit area, and the dock adds its own
     gap — stacked, they read as one wide space beside the model selector. Pull
     the BOX back by part of that padding so the visual edge sits at the dock's
     rhythm. The hit area is untouched: shrinking the padding instead would trade
     accessibility for spacing, which is the wrong trade. */
  margin-right: -6px;
  /* Hug the content. A slot wrapper may stretch its child, and a stretched box
     makes the pill's hover tint wider than the thing inside it — an edge with
     nothing in it. */
  flex: none;
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
  /* Trimmed from 3px 9px: the box read as a fat edge around a 12px label. The
   * target is still ~18px tall and ~48px wide, which is a comfortable hit area
   * — this trims the edge, it does not remove the target. */
  padding: 2px 7px;
  /* --dsw-radius-sm (8px), and the RATIO is the reason — not the token.
   *
   * The host's own controls (Button, Input, SegmentedControl) all declare
   * --dsw-radius-md, and this trigger first copied them. That is right at their
   * height: 12px on a ~28px control is 43% of it, which reads as a rounded
   * rect. This trigger is ~20px tall, so the same 12px clamps to 10px — 50% of
   * the box, which IS a stadium, and the owner read it as too round.
   *
   * Same host ladder, one step down: 8px on 20px restores the host's own
   * ratio. The value comes from the theme; only the rung changes. */
  border-radius: var(--dsw-radius-sm, 8px);
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
  color: var(--dsw-alias-state-error-primary, #e5484d);
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
  /*
   * NO background, NO backdrop-filter, and no data-menu-material here.
   *
   * The host's MenuSurface owns the menu material, and the panel renders
   * THROUGH it: MenuSurface draws a separate .material layer layer at z-index -1
   * behind the content, sets isolation: isolate on the surface so that
   * negative index stays contained, and portals an opaque .backing layer into
   * document.body so Chromium has something to blur on macOS.
   *
   * Hand-rolling the fill on the panel itself was the transparency:
   * --dsw-menu-surface-fill is ~58% opaque, and with no backing behind it the
   * page showed straight through. The panel supplies GEOMETRY; the host
   * supplies the material.
   */
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
   *   box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.18))
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

/* The kit's dot keeps a 10px SLOT but paints a 6px core inside it, so 2px of
   every side is empty. A 7px gap therefore read as ~9px beside a 6px circle —
   the dot looked detached from its label, like a marker hanging at the row's
   front. 4px makes the optical gap match the circle. */
.dsh-oc-usage-row-left {
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
   window's own colour. Two pixels — a progress bar that is also a ruler.
   It spans the WHOLE row, starting under the state dot: the 13px indent that
   used to align it with the label left the dot hanging outside the row's own
   bounds, like a list marker, and cost the ruler the width it exists to use. */
.dsh-oc-usage-bar {
  height: 2px;
  margin-top: 4px;
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
  color: var(--dsw-alias-state-error-primary, #e5484d);
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
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3b82f6));
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
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3b82f6));
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
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 12%, transparent);
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-size: 11px;
  line-height: 1.45;
  margin-top: 8px;
}

.dsh-oc-usage-warning strong {
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
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 12%, transparent);
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
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, currentColor);
  white-space: nowrap;
}
`;

// The stylesheet is rendered as a `<style>` element inside this component's own
// tree (see `ActiveUsage`) instead of being appended to `document.head`: writing
// DOM outside the component leaks a permanent `<style>` node on unmount and is
// disallowed for DSH client plugins.
