/**
 * Word-level diff rendered as Markdown for Raycast's Detail view.
 *
 * Two renderings are produced from one diff:
 *
 * - `highlighted` mirrors Raycast's built-in command: the corrected text reads
 *   as normal prose and only the changed words are marked. Raycast's Markdown
 *   subset has no background colour, so changed words become inline-code spans,
 *   which is the only construct that renders with a tinted background.
 * - `full` also shows what was removed, as ~~struck~~ text, for the cases the
 *   highlighted view cannot express — a pure deletion has nothing to mark.
 */

type OpKind = "equal" | "delete" | "insert";

interface Op {
  kind: OpKind;
  tokens: string[];
}

export interface DiffResult {
  /** Corrected prose with changed words highlighted. */
  highlighted: string;
  /** Corrected prose plus ~~removals~~. */
  full: string;
  /** Changed regions, counting a substitution as one — matches the built-in's tally. */
  changes: number;
  /**
   * Text the model deleted without putting anything in its place — an emoji it
   * tidied away, a clause it dropped. The highlighted view cannot show these, so
   * the caller must warn about them or they vanish silently into the paste.
   */
  removed: string[];
  characters: number;
  words: number;
  /** True when the inputs were too large to diff, so both views are plain text. */
  truncated: boolean;
}

/** Beyond this the quadratic LCS table costs more than the diff is worth. */
const MAX_TOKENS = 2500;

export function diffMarkdown(original: string, corrected: string): DiffResult {
  const stats = { characters: corrected.length, words: countWords(corrected) };

  if (original === corrected) {
    return {
      highlighted: asMarkdownText(corrected),
      full: asMarkdownText(corrected),
      changes: 0,
      removed: [],
      ...stats,
      truncated: false,
    };
  }

  const a = tokenize(original);
  const b = tokenize(corrected);

  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    const plain = asMarkdownText(corrected);
    return { highlighted: plain, full: plain, changes: -1, removed: [], ...stats, truncated: true };
  }

  const ops = coalesce(lcsDiff(a, b));

  return {
    highlighted: hardBreaks(renderHighlighted(ops)),
    full: hardBreaks(renderFull(ops)),
    changes: countChangedRegions(ops),
    removed: findUnreplacedRemovals(ops),
    ...stats,
    truncated: false,
  };
}

/**
 * Deletions with no insertion beside them.
 *
 * A deletion adjacent to an insertion is a substitution — the replacement is
 * visible, so there is nothing to warn about. A deletion between two unchanged
 * runs is content that simply disappeared.
 */
function findUnreplacedRemovals(ops: Op[]): string[] {
  const removed: string[] = [];

  ops.forEach((op, index) => {
    if (op.kind !== "delete") return;
    if (ops[index - 1]?.kind === "insert" || ops[index + 1]?.kind === "insert") return;

    const text = op.tokens.join("").trim();
    if (text) removed.push(text);
  });

  return removed;
}

/** Renders plain text in the Detail view with its line structure intact. */
export function asMarkdownText(text: string): string {
  return hardBreaks(escapeMarkdown(text));
}

export interface RepairResult {
  text: string;
  /** Emoji put back, in the order they appear. */
  restored: string[];
}

/**
 * Puts back emoji the model deleted.
 *
 * Asking a model to preserve emoji works most of the time, which is not good
 * enough — a dropped emoji is silent data loss in whatever the user pastes. So
 * the deletion is undone mechanically instead: diff the two texts, and reinstate
 * any deleted run that is purely emoji and whitespace.
 *
 * Only emoji are restored. A deleted run containing letters or digits is left
 * alone, because there the model may legitimately be fixing a duplicated word.
 */
export function restoreDroppedEmoji(original: string, corrected: string): RepairResult {
  if (original === corrected) return { text: corrected, restored: [] };

  const a = tokenize(original);
  const b = tokenize(corrected);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return { text: corrected, restored: [] };

  const ops = lcsDiff(a, b);
  const restored: string[] = [];
  let text = "";
  let index = 0;

  while (index < ops.length) {
    if (ops[index].kind !== "delete") {
      text += ops[index].tokens.join("");
      index++;
      continue;
    }

    // Take the whole run of consecutive deletions and decide what to salvage.
    const deleted: string[] = [];
    while (index < ops.length && ops[index].kind === "delete") {
      deleted.push(ops[index].tokens.join(""));
      index++;
    }

    const fragment = salvageEmoji(deleted);
    if (!fragment) continue;

    // Reinstate the original spacing rather than inventing a space: a tab or a
    // blank line must come back as a tab or a blank line, not be flattened.
    const following = ops[index]?.tokens.join("");
    let spliced = fragment;
    if (/\s$/u.test(text)) spliced = spliced.replace(/^\s+/u, "");
    if (following !== undefined && /^\s/u.test(following)) spliced = spliced.replace(/\s+$/u, "");

    text += spliced;
    restored.push(...deleted.filter(isEmoji));
  }

  return { text, restored };
}

/**
 * From a run of deleted tokens, keeps the emoji and the whitespace that was
 * between them; returns undefined when the run held no emoji at all.
 *
 * Dropping the words can leave two whitespace tokens adjacent, which would
 * double a space, so a whitespace token following another is skipped.
 */
function salvageEmoji(deleted: string[]): string | undefined {
  if (!deleted.some(isEmoji)) return undefined;

  const kept: string[] = [];

  for (const token of deleted) {
    const whitespace = /^\s+$/u.test(token);
    if (!whitespace && !isEmoji(token)) continue;
    if (whitespace && kept.length > 0 && /^\s+$/u.test(kept[kept.length - 1])) continue;
    kept.push(token);
  }

  return kept.join("");
}

/**
 * True for a token that is entirely emoji.
 *
 * `Extended_Pictographic` alone is not enough: flags are pairs of
 * `Regional_Indicator` code points and match none of it. Joiners, variation
 * selectors and skin-tone modifiers must count as part of the emoji so that a
 * sequence is recovered whole rather than half.
 */
function isEmoji(token: string): boolean {
  // Alternation rather than one character class: a zero-width joiner and a
  // variation selector are combining marks, which do not belong in one.
  const emojiParts = /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]|‍|️)+$/u;
  const hasPictograph = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

  return emojiParts.test(token) && hasPictograph.test(token);
}

function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/**
 * Splits into whitespace runs, word cores, and the punctuation around them.
 *
 * Keeping punctuation as its own token stops it being swept into a highlight:
 * fixing `quicky.` marks `quickly` and leaves the full stop plain, which is how
 * the built-in command renders it. Whitespace stays a token so whitespace-only
 * edits are still visible.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const chunk of text.split(/(\s+)/)) {
    if (chunk === "") continue;
    if (/^\s+$/.test(chunk)) {
      tokens.push(chunk);
      continue;
    }

    tokens.push(...splitOffEmoji(chunk));
  }

  return tokens;
}

/** Emoji sequence, including joiners, variation selectors and skin-tone modifiers. */
const EMOJI_SEQUENCE = /(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]|‍|️)+/gu;

/**
 * Pulls emoji out as tokens of their own, wherever they sit.
 *
 * Emoji are not always surrounded by spaces — `🎉,` and `word🎉word` both occur —
 * and an emoji sharing a token with punctuation or letters cannot be recognised
 * as an emoji later, so it would be neither highlighted correctly nor recovered.
 */
function splitOffEmoji(chunk: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  for (const match of chunk.matchAll(EMOJI_SEQUENCE)) {
    if (match.index > index) tokens.push(...splitOffPunctuation(chunk.slice(index, match.index)));
    tokens.push(match[0]);
    index = match.index + match[0].length;
  }

  if (index < chunk.length) tokens.push(...splitOffPunctuation(chunk.slice(index)));

  return tokens;
}

/** Separates a word from the punctuation hanging off either end. */
function splitOffPunctuation(chunk: string): string[] {
  const [, leading, core, trailing] = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(chunk) ?? [];
  return [leading, core, trailing].filter((part): part is string => Boolean(part));
}

function lcsDiff(a: string[], b: string[]): Op[] {
  // lengths[i][j] = LCS length of a[i..] and b[j..]
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", tokens: [a[i]] });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      ops.push({ kind: "delete", tokens: [a[i]] });
      i++;
    } else {
      ops.push({ kind: "insert", tokens: [b[j]] });
      j++;
    }
  }

  while (i < a.length) ops.push({ kind: "delete", tokens: [a[i++]] });
  while (j < b.length) ops.push({ kind: "insert", tokens: [b[j++]] });

  return ops;
}

/** Merges runs of the same kind so adjacent tokens render as one span. */
function coalesce(ops: Op[]): Op[] {
  const merged: Op[] = [];

  for (const op of ops) {
    const previous = merged[merged.length - 1];
    if (previous?.kind === op.kind) {
      previous.tokens.push(...op.tokens);
    } else {
      merged.push({ kind: op.kind, tokens: [...op.tokens] });
    }
  }

  return merged;
}

/** A delete run followed by an insert run is one substitution, not two changes. */
function countChangedRegions(ops: Op[]): number {
  let regions = 0;
  let inRegion = false;

  for (const op of ops) {
    if (op.kind === "equal") {
      inRegion = false;
    } else if (!inRegion) {
      regions++;
      inRegion = true;
    }
  }

  return regions;
}

/** The corrected text, with inserted words marked and removals dropped. */
function renderHighlighted(ops: Op[]): string {
  return ops
    .map((op) => {
      if (op.kind === "delete") return "";
      const text = op.tokens.join("");
      return op.kind === "equal" ? escapeMarkdown(text) : markWords(text);
    })
    .join("");
}

/** The corrected text plus struck-through removals. */
function renderFull(ops: Op[]): string {
  return ops
    .map((op) => {
      const text = op.tokens.join("");
      if (op.kind === "equal") return escapeMarkdown(text);
      return op.kind === "insert" ? markWords(text) : strikeWords(text);
    })
    .join("");
}

/**
 * Decorates each word individually, passing whitespace through untouched.
 *
 * Decorating a whole run instead would put whitespace inside the delimiters —
 * `~~b ~~` never closes, and a code span cannot contain a newline at all.
 */
function wrapWords(text: string, wrap: (word: string) => string): string {
  return text
    .split(/(\s+)/)
    .map((chunk) => (chunk === "" || /^\s+$/.test(chunk) ? chunk : wrap(chunk)))
    .join("");
}

function markWords(text: string): string {
  return wrapWords(text, codeSpan);
}

function strikeWords(text: string): string {
  return wrapWords(text, (word) => `~~${escapeMarkdown(word)}~~`);
}

/** Fences content in enough backticks to contain any it already holds. */
function codeSpan(content: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  // A leading/trailing space is required when the content starts or ends with a backtick.
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

/** Neutralises Markdown that would otherwise reflow the text, leaving line breaks intact. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_~[\]#>|])/g, "\\$1");
}

/** Markdown collapses single newlines; two trailing spaces force a real line break. */
function hardBreaks(text: string): string {
  return text.replace(/\n/g, "  \n");
}
