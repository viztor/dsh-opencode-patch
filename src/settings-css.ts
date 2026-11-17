/**
 * The settings card's stylesheet, as one string the card renders in a
 * `<style>` element of its own tree — the meter's idiom (`usage-css.ts`).
 * Dependency-free, so a test can read the rules without React.
 *
 * Every declaration here was an inline `style` prop on the card, the field
 * shell, the store row or the usage summary, moved with its value. Three
 * rules hold the sheet:
 *
 * - colours are the host's `--dsw-*` tokens, with no literal colour and no
 *   token-to-token fallback (`test/host-tokens.test.ts`);
 * - a modifier comes AFTER its base at equal specificity (`-outcome` then
 *   `-outcome-warn`), so the later rule is the one that applies, and a pinned
 *   colour is a longhand (`color`, `background-color`), which is how the
 *   mounted pins read a declaration (`test/support/declared-style.ts`);
 * - comments stay brace-free, as in the meter's sheet.
 *
 * @module dsh-opencode-patch/settings-css
 */

export const CARD_STYLES = `
/* The host's own font, named explicitly rather than inherited. A plugin card
   rendered into the settings page inherits from whatever wraps it, and what
   wraps it does not set the family, so the text fell back to the browser's
   default. The fallback is inherit, which is what happened before. */
.dsh-oc-card {
  font-family: var(--dsw-font-family, inherit);
}

/* A block of its own above the form: the purge row, the store row. */
.dsh-oc-card-section {
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  margin-bottom: 16px;
  padding-bottom: 14px;
}

/* The quota readout gets more room: who is signed in, what the quota is, and
   the form are three different things, and 12px made them read as one
   crowded column with the hairline doing all the separating. */
.dsh-oc-card-section-usage {
  margin-bottom: 20px;
  padding-bottom: 16px;
}

/* Section heading between register groups. Only a heading after another one
   draws the separator rule: the first group opens the form. */
.dsh-oc-card-group {
  padding-top: 6px;
}

.dsh-oc-card-group ~ .dsh-oc-card-group {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  margin-top: 10px;
}

.dsh-oc-card-group-label {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* One action: a title and a hint on the left, the button on the right. A
   second action in the same section sits 12px below what precedes it. */
.dsh-oc-card-action {
  align-items: center;
  display: flex;
  gap: 12px;
  justify-content: space-between;
}

.dsh-oc-card-action ~ .dsh-oc-card-action {
  margin-top: 12px;
}

.dsh-oc-card-action-title {
  font-size: 13px;
  font-weight: 600;
}

.dsh-oc-card-action-hint {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  margin-top: 2px;
}

.dsh-oc-card-action-detail {
  font-size: 12px;
  margin-top: 4px;
}

/* One outcome line under an action, in the warn colour when it warns. */
.dsh-oc-card-outcome {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  margin-top: 6px;
}

.dsh-oc-card-outcome-warn {
  color: var(--dsw-alias-state-warn-label);
}

/* Said once, above the form, rather than in every control's hint. */
.dsh-oc-card-note {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  margin-bottom: 8px;
}

/* The store row's report: labelled rows, then its note. */
.dsh-oc-card-report {
  font-size: 12px;
  margin-top: 8px;
}

.dsh-oc-card-report-row {
  display: flex;
  gap: 8px;
  padding: 1px 0;
}

.dsh-oc-card-report-label {
  color: var(--dsw-alias-label-caption);
  flex: 0 0 auto;
  min-width: 72px;
}

.dsh-oc-card-report-value {
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A non-text field: label, override badge with its reset, the control, and
   one message line. A Switch stays beside its label, whose text wraps; only
   the segmented choice's head wraps (its -wraps modifier), so a control
   wider than the room beside its label drops under it rather than squeezing
   the label. */
.dsh-oc-card-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}

.dsh-oc-card-field-head {
  align-items: center;
  display: flex;
  gap: 8px;
}

.dsh-oc-card-field-title {
  align-items: center;
  display: flex;
  flex: 1;
  gap: 4px;
  min-width: 0;
}

.dsh-oc-card-field-head-wraps {
  flex-wrap: wrap;
}

.dsh-oc-card-field-head-wraps > .dsh-oc-card-field-title {
  flex: 1 1 auto;
}

.dsh-oc-card-field-label {
  color: var(--dsw-alias-label-primary);
  flex: 0 1 auto;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}

.dsh-oc-card-field-override {
  align-items: center;
  display: inline-flex;
  gap: 8px;
}

/* An invalid draft replaces the hint rather than stacking a second message
   under it, so one line carries either. */
.dsh-oc-card-field-message {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
}

.dsh-oc-card-field-message-invalid {
  color: var(--dsw-alias-state-error-primary);
}

/* The Go usage summary: a heading row, one row per window, the allowance. */
.dsh-oc-card-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dsh-oc-card-summary-head {
  align-items: baseline;
  display: flex;
  justify-content: space-between;
}

.dsh-oc-card-summary-title {
  align-items: center;
  display: inline-flex;
  font-size: 12px;
  font-weight: 600;
  gap: 4px;
}

.dsh-oc-card-summary-status {
  align-items: center;
  display: inline-flex;
  gap: 6px;
}

.dsh-oc-card-summary-status-text {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}

.dsh-oc-card-summary-row {
  align-items: center;
  display: flex;
  font-size: 11px;
  gap: 8px;
}

.dsh-oc-card-summary-label {
  flex: 0 0 46px;
}

.dsh-oc-card-summary-detail {
  color: var(--dsw-alias-label-secondary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* What is LEFT, held out on the right the way the console does. */
.dsh-oc-card-summary-left {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  text-align: right;
}

.dsh-oc-card-summary-remaining {
  color: var(--dsw-alias-label-tertiary);
  flex: 0 0 26px;
}

.dsh-oc-card-summary-allowance {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}

/* The info affordance: a control, not decoration, so it says it is
   hoverable. */
.dsh-oc-card-info {
  color: var(--dsw-alias-label-tertiary);
  cursor: help;
  display: inline-flex;
}

/* The summary's refresh is the host's ghost Button at its small size, 28px
   square here. The negative block margin keeps the heading row at the 18px
   the old control had; the element selector lets this placement win over
   the Button module's own size rule at equal class specificity. Hover, focus
   and the disabled state are the Button's. */
button.dsh-oc-card-refresh {
  color: var(--dsw-alias-label-secondary);
  margin: -5px 0;
  padding: 0;
  width: 28px;
}

/* The control is busy mid-read; the glyph turns rather than disappearing.
   The keyframes are the card's own, so the summary turns with no meter on
   the page; the meter's sheet declares the same animation, body for body. */
.dsh-oc-card-refresh:disabled .dsh-oc-card-refresh-icon {
  animation: dsh-oc-spin 0.9s linear infinite;
}

@keyframes dsh-oc-spin {
  to {
    transform: rotate(360deg);
  }
}
`;
