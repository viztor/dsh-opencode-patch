/**
 * Comment blanking for the source-reading gates, one line at a time.
 *
 * The gates used to strip block comments with a regex over the whole file,
 * `/\/\*[\s\S]*?\*\//`, before the line comments. That regex cannot see
 * string literals or `//` comments, so a glob such as `"locale/*.json"` opened
 * a fake block that ran to the next `*\/` and blanked the code in between —
 * seventy lines of one test file, silently. A gate that misses code is worse
 * than one that flags a comment, so this reader is built to err loudly:
 *
 * - a line whose first non-blank text is `//` is blanked;
 * - a block comment is recognised only where it OPENS a line, and runs to the
 *   first `*\/`; whatever follows that `*\/` on its closing line is read the
 *   same way, so it may be code, a `//` comment, or another block — one that
 *   may itself run on to later lines;
 * - a `/*` anywhere else — in a string, after code, in a JSX `{/* … *\/}` — is
 *   left as text, so at worst a comment's words are read as code;
 * - a block still open at the end of the source throws: an unterminated block
 *   comment is a syntax error in real TypeScript, so its `/*` was not a
 *   comment, and the gate fails rather than passing on a blanked file.
 *
 * One blind spot remains, and it is narrow: a line INSIDE a multi-line string
 * or template literal that begins with `/*` and is closed by a later real
 * `*\/` is blanked as a comment, along with the lines between. The CSS
 * comments inside `src/usage-ui.ts`'s template literal are that shape, and are
 * harmless because they are comments.
 *
 * Line breaks are kept, so a `file:line` computed on the result is true.
 *
 * @module test/support/strip-comments
 */

/** `source` with its comment lines blanked and its line count unchanged. */
export const blankCommentLines = (source: string): string => {
  let inBlock = false;
  let openedAt = 0;
  // One line, or the tail of one after a `*/`, read with the block state the
  // whole source shares, so a block that opens in a tail runs on to the next
  // lines.
  const blankLine = (text: string, lineNumber: number): string => {
    let rest = text;
    if (!inBlock) {
      const trimmed = rest.trimStart();
      if (trimmed.startsWith("//")) {
        return "";
      }
      if (!trimmed.startsWith("/*")) {
        return rest;
      }
      inBlock = true;
      openedAt = lineNumber;
      rest = trimmed.slice(2);
    }
    const close = rest.indexOf("*/");
    if (close === -1) {
      return "";
    }
    inBlock = false;
    return blankLine(rest.slice(close + 2), lineNumber);
  };
  const lines = source
    .split("\n")
    .map((line, index) => blankLine(line, index + 1));
  if (inBlock) {
    throw new Error(
      `blankCommentLines: the block comment opened on line ${openedAt} never closes, so its \`/*\` is not a comment (a string or template literal?)`
    );
  }
  return lines.join("\n");
};
