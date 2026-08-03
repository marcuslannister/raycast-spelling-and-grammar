/**
 * Smoke tests for the diff renderer, runnable without Raycast.
 * Run with: node scripts/test-diff.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "raycast-spelling-test-"));

// Transpile the pure module to plain ESM so it can run under node directly.
execFileSync(
  "npx",
  [
    "tsc",
    join(root, "src", "diff.ts"),
    "--outDir",
    outDir,
    "--module",
    "esnext",
    "--target",
    "es2022",
    "--moduleResolution",
    "bundler",
  ],
  { cwd: root, stdio: "inherit" },
);

// tsc emits .js without an ESM package marker; add one.
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }));

const { diffMarkdown, asMarkdownText, restoreDroppedEmoji } = await import(join(outDir, "diff.js"));

let failures = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`✗ ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

// --- identical input ---------------------------------------------------------
{
  const same = diffMarkdown("All good here.", "All good here.");
  check("identical text reports zero changes", same.changes, 0);
  check("identical text is shown verbatim", same.highlighted, "All good here.");
  check("identical text marks nothing", same.highlighted.includes("`"), false);
}

// --- the built-in's example: two word substitutions = "2 Changes" ------------
{
  const before = "Denis joined last August and got up to speed remarkably quicky. He's the person who asks the right questions in grooming sesions.";
  const after = "Denis joined last August and got up to speed remarkably quickly. He's the person who asks the right questions in grooming sessions.";
  const d = diffMarkdown(before, after);

  check("substitution pair counts as one change each", d.changes, 2);
  check("highlighted view marks the corrected word", d.highlighted.includes("`quickly`"), true);
  check("highlighted view marks the second correction", d.highlighted.includes("`sessions`"), true);
  // The built-in leaves punctuation outside the tint; so do we.
  check("punctuation stays outside the highlight", d.highlighted.includes("`quickly`."), true);
  check("highlighted view drops the misspelling entirely", d.highlighted.includes("quicky"), false);
  check("highlighted view has no strikethrough", d.highlighted.includes("~~"), false);
  check("highlighted view keeps surrounding prose plain", d.highlighted.includes("got up to speed remarkably"), true);
  check("full view keeps the removal", d.full.includes("~~quicky~~"), true);
  check("word count is of the corrected text", d.words, 22);
  check("character count is of the corrected text", d.characters, after.length);
}

// --- single substitution counts once, not twice -----------------------------
{
  const one = diffMarkdown("Their going home.", "They're going home.");
  check("one substitution is one change", one.changes, 1);
  check("substitution marks the replacement", one.highlighted.includes("`They're`"), true);
  check("substitution keeps unchanged words plain", one.highlighted.includes("going home."), true);
}

// --- punctuation is never swept into a highlight ----------------------------
{
  const trailing = diffMarkdown("wrong speling.", "wrong spelling.");
  check("trailing full stop stays plain", trailing.highlighted, "wrong `spelling`.");

  const quoted = diffMarkdown('he said "helo"', 'he said "hello"');
  check("surrounding quotes stay plain", quoted.highlighted, 'he said "`hello`"');

  const hyphen = diffMarkdown("a well-known problem occured", "a well-known problem occurred");
  check("hyphenated words are not split apart", hyphen.highlighted, "a well-known problem `occurred`");
  check("hyphenated unchanged word is not marked", hyphen.changes, 1);

  const apostrophe = diffMarkdown("i dont know", "I don't know");
  check("apostrophes stay inside the word", apostrophe.highlighted, "`I` `don't` know");
}

// --- pure insertion and pure deletion ---------------------------------------
{
  check("pure insertion is one change", diffMarkdown("a c", "a b c").changes, 1);
  check("pure insertion is marked", diffMarkdown("a c", "a b c").highlighted.includes("`b`"), true);

  const deletion = diffMarkdown("a b c", "a c");
  check("pure deletion is one change", deletion.changes, 1);
  // A deletion has nothing to highlight — this is why the full view exists.
  check("pure deletion marks nothing in the highlighted view", deletion.highlighted.includes("`"), false);
  check("pure deletion is visible in the full view", deletion.full.includes("~~b~~"), true);
}

// --- emoji and other non-letter characters survive rendering ----------------
{
  // The model dropping an emoji is a prompt problem; corrupting one here would be ours.
  const strip = (markdown) =>
    markdown
      .replace(/`+/g, "")
      .replace(/\\(.)/g, "$1")
      .replace(/ {2}\n/g, "\n");

  const cases = [
    ["great work 🎉 thnaks", "great work 🎉 thanks"],
    ["family 👨‍👩‍👧 photo is nise", "family 👨‍👩‍👧 photo is nice"],
    ["flag 🇩🇪 and skin tone 👍🏽 ok", "flag 🇩🇪 and skin tone 👍🏽 OK"],
    ["emoji at end is fine 🚀", "Emoji at end is fine 🚀"],
    ["math ∑ and arrow → kept, speling", "math ∑ and arrow → kept, spelling"],
  ];

  const corrupted = cases.filter(([before, after]) => strip(diffMarkdown(before, after).highlighted) !== after);
  check("emoji and symbols survive the highlighted view", corrupted, []);

  // An emoji is neither letter nor number, so it must not be swallowed by a highlight.
  const d = diffMarkdown("nice 🎉 wrok", "nice 🎉 work");
  check("an untouched emoji is not highlighted", d.highlighted, "nice 🎉 `work`");
  check("an untouched emoji is not a change", d.changes, 1);
}

// --- deletions with no replacement are reported ------------------------------
{
  const dropped = diffMarkdown("great work 🎉 thanks", "great work thanks");
  check("a dropped emoji is reported as removed", dropped.removed, ["🎉"]);
  check("a dropped emoji is invisible in the highlighted view", dropped.highlighted.includes("🎉"), false);
  check("a dropped emoji is visible in the full view", dropped.full.includes("~~🎉~~"), true);

  const clause = diffMarkdown("keep this, drop that, end", "keep this, end");
  check("a dropped clause is reported", clause.removed, ["drop that,"]);

  // A substitution replaces the text, so there is nothing to warn about.
  const substitution = diffMarkdown("Their going", "They're going");
  check("a substitution reports no removal", substitution.removed, []);

  const identical = diffMarkdown("no change 🎉", "no change 🎉");
  check("identical text reports no removal", identical.removed, []);

  const multiple = diffMarkdown("a X b Y c", "a b c");
  check("several unreplaced removals are all reported", multiple.removed, ["X", "Y"]);
}

// --- dropped emoji are put back deterministically ---------------------------
{
  // The whole point: the model deletes an emoji, we undo it, in the right place.
  const mid = restoreDroppedEmoji("great work 🎉 thanks", "great work thanks");
  check("emoji dropped mid-sentence is restored", mid.text, "great work 🎉 thanks");
  check("restored emoji is reported", mid.restored, ["🎉"]);

  const end = restoreDroppedEmoji("ship it 🚀", "Ship it");
  check("emoji dropped at the end is restored", end.text, "Ship it 🚀");

  const start = restoreDroppedEmoji("🎉 we shipped", "We shipped");
  check("emoji dropped at the start is restored", start.text, "🎉 We shipped");

  // Restoration must survive alongside a real correction.
  const both = restoreDroppedEmoji("nice 🎉 wrok", "nice work");
  check("emoji restored while a typo is still fixed", both.text, "nice 🎉 work");

  const several = restoreDroppedEmoji("a 🎉 b 🚀 c 👋 d", "a b c d");
  check("every dropped emoji is restored", several.text, "a 🎉 b 🚀 c 👋 d");
  check("all restorations are reported", several.restored, ["🎉", "🚀", "👋"]);

  // Multi-code-point emoji must not be half-restored.
  const family = restoreDroppedEmoji("our 👨‍👩‍👧 photo", "our photo");
  check("ZWJ sequence is restored whole", family.text, "our 👨‍👩‍👧 photo");
  const flag = restoreDroppedEmoji("from 🇩🇪 here", "from here");
  check("regional indicator flag is restored whole", flag.text, "from 🇩🇪 here");
  const tone = restoreDroppedEmoji("yes 👍🏽 indeed", "yes indeed");
  check("skin-tone modifier is restored whole", tone.text, "yes 👍🏽 indeed");
}

// --- the repair must not overreach ------------------------------------------
{
  const untouched = restoreDroppedEmoji("all 🎉 good", "all 🎉 good");
  check("identical text is returned unchanged", untouched.text, "all 🎉 good");
  check("identical text restores nothing", untouched.restored, []);

  const kept = restoreDroppedEmoji("nice 🎉 wrok", "nice 🎉 work");
  check("a kept emoji is not duplicated", kept.text, "nice 🎉 work");
  check("a kept emoji is not reported as restored", kept.restored, []);

  // Deletions containing real words are the model's business, not ours.
  const duplicate = restoreDroppedEmoji("the the cat sat", "the cat sat");
  check("a deleted duplicate word stays deleted", duplicate.text, "the cat sat");
  check("deleting a word restores nothing", duplicate.restored, []);

  const clause = restoreDroppedEmoji("keep this, drop that, end", "keep this, end");
  check("a deleted clause stays deleted", clause.text, "keep this, end");

  // An emoji is recovered even when the model also deleted a word beside it:
  // the word stays the model's decision, the emoji does not.
  const mixed = restoreDroppedEmoji("say hello 🎉 friend", "say friend");
  check("emoji beside a deleted word is still restored", mixed.text, "say 🎉 friend");
  check("the deleted word beside it stays deleted", mixed.text.includes("hello"), false);

  // Punctuation is not emoji; the model may legitimately fix it.
  const punctuation = restoreDroppedEmoji("wait -- what", "wait what");
  check("deleted punctuation is not restored", punctuation.text, "wait what");

  // Non-emoji symbols are out of scope.
  const symbol = restoreDroppedEmoji("sum ∑ here", "sum here");
  check("a deleted maths symbol is not restored", symbol.restored, []);
}

// --- original whitespace is reinstated, not flattened to a space ------------
{
  const blankLine = restoreDroppedEmoji("multi\n\n🎉\n\npara", "multi\n\npara");
  check("a blank line around the emoji is preserved", blankLine.text, "multi\n\n🎉\n\npara");

  const tab = restoreDroppedEmoji("tab\t🎉\tsep", "tab\tsep");
  check("a tab around the emoji is preserved", tab.text, "tab\t🎉\tsep");

  const newline = restoreDroppedEmoji("line one 🎉\nline two", "line one\nline two");
  check("a line break after the emoji is preserved", newline.text, "line one 🎉\nline two");

  const trailing = restoreDroppedEmoji("trailing 🎉   ", "trailing   ");
  check("trailing spaces are not disturbed", trailing.text, "trailing 🎉   ");

  const adjacent = restoreDroppedEmoji("punct 🎉, then", "punct, then");
  check("emoji before punctuation is restored in place", adjacent.text, "punct 🎉, then");

  const glued = restoreDroppedEmoji("🎉🚀 both", "both");
  check("adjacent emoji are restored together", glued.text, "🎉🚀 both");

  const only = restoreDroppedEmoji("🎉", "");
  check("an emoji-only input is recovered", only.text, "🎉");
}

// --- known limits: the emoji is kept, but its position can shift -------------
{
  // Documented, not desired. Both need character-level diffing to place exactly.
  // What matters is that the emoji is never lost.

  // The model merged the word around the emoji, so there is no longer a word
  // boundary to anchor it to.
  const merged = restoreDroppedEmoji("no space🎉here", "no spacehere");
  check("emoji survives a merged word", merged.text.includes("🎉"), true);
  check("emoji lands before the merged word", merged.text, "no 🎉spacehere");

  // `()` tokenizes as one blob, so there is no gap between the brackets to
  // reinstate the emoji into.
  const brackets = restoreDroppedEmoji("(🎉) parens", "() parens");
  check("emoji survives deletion from inside brackets", brackets.text.includes("🎉"), true);
  check("emoji lands before the brackets", brackets.text, "🎉() parens");
}

// --- repaired text feeds cleanly back into the diff --------------------------
{
  const original = "great work 🎉 thnaks";
  const repaired = restoreDroppedEmoji(original, "great work thanks");
  const d = diffMarkdown(original, repaired.text);

  check("after repair the emoji is no longer reported as removed", d.removed, []);
  check("after repair the emoji is not highlighted as new", d.highlighted, "great work 🎉 `thanks`");
  check("after repair only the real correction counts", d.changes, 1);
}

// --- multi-line input keeps its structure -----------------------------------
{
  const multi = diffMarkdown("line one\nline too", "line one\nline two");
  check("multi-line uses markdown hard breaks", multi.highlighted.includes("  \n"), true);
  check("multi-line marks only the changed word", multi.highlighted.includes("`two`"), true);
  check("multi-line leaves the untouched line alone", multi.highlighted.includes("line one"), true);
}

// --- inserted text spanning a line break -----------------------------------
{
  const d = diffMarkdown("a d", "a b\nc d");
  check("insertion spanning a newline does not break the code span", d.highlighted.includes("`b`"), true);
  check("insertion spanning a newline marks both words separately", d.highlighted.includes("`c`"), true);
  // Every span must open and close on one line, so each line needs an even backtick count.
  const unbalanced = d.highlighted.split("\n").filter((line) => (line.match(/`/g)?.length ?? 0) % 2 !== 0);
  check("every code span opens and closes on the same line", unbalanced, []);
}

// --- delimiters must never enclose whitespace -------------------------------
{
  // `~~b ~~` does not close, and a code span cannot hold a newline.
  const cases = [
    diffMarkdown("a b c", "a c"),
    diffMarkdown("keep one two three end", "keep end"),
    diffMarkdown("first\nsecond\nthird", "first\nthird"),
    diffMarkdown("a d", "a b\nc d"),
  ];

  /** Contents of each delimited span, so we can assert on what is *inside* them. */
  function spanContents(view, pattern) {
    return [...view.matchAll(pattern)].map((match) => match[1]);
  }

  const struck = cases.flatMap((d) => spanContents(d.full, /~~([^~]*)~~/g));
  const coded = cases.flatMap((d) => [
    ...spanContents(d.highlighted, /(?<!`)`([^`]*)`(?!`)/g),
    ...spanContents(d.full, /(?<!`)`([^`]*)`(?!`)/g),
  ]);

  check("something was struck through", struck.length > 0, true);
  check("something was highlighted", coded.length > 0, true);
  check(
    "struck spans hold no whitespace",
    struck.filter((content) => content !== content.trim() || content === ""),
    [],
  );
  check(
    "code spans hold no newline",
    coded.filter((content) => content.includes("\n")),
    [],
  );
}

// --- markdown in the source is escaped, not rendered ------------------------
{
  const escaped = diffMarkdown("a *star* and _score_", "a *star* and _score_ ok");
  check("asterisks are escaped in unchanged text", escaped.highlighted.includes("\\*star\\*"), true);
  check("underscores are escaped in unchanged text", escaped.highlighted.includes("\\_score\\_"), true);
}

// --- backticks in inserted text do not break the code span ------------------
{
  const d = diffMarkdown("run this", "run `this`");
  check("inserted backticked word is fenced with more backticks", d.highlighted.includes("``"), true);
  check("inserted content survives intact", d.highlighted.includes("`this`"), true);
}

// --- plain renderer ---------------------------------------------------------
check("asMarkdownText escapes and hard-breaks", asMarkdownText("a *b*\nc"), "a \\*b\\*  \nc");

// --- oversized input falls back rather than hanging -------------------------
{
  const huge = "word ".repeat(3000);
  const start = process.hrtime.bigint();
  const big = diffMarkdown(huge, huge + "extra");
  const ms = Number(process.hrtime.bigint() - start) / 1e6;

  check("oversized input is flagged as truncated", big.truncated, true);
  check("oversized input still shows the corrected text", big.highlighted.length > 0, true);
  check("oversized input still counts words", big.words, 3001);
  check("oversized input returns fast", ms < 200, true);
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
