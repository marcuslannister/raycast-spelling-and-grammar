/**
 * Smoke tests for the SSE reader and the per-provider delta extractors.
 * Exercises the awkward cases: frames split mid-JSON across chunks, CRLF
 * line endings, comment/keep-alive frames, `[DONE]`, and malformed frames.
 *
 * Run with: node scripts/test-stream.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "raycast-spelling-stream-"));

// providers.ts is pure apart from `fetch`, which these tests never reach.
execFileSync(
  "npx",
  [
    "tsc",
    join(root, "src", "providers.ts"),
    "--outDir",
    outDir,
    "--module",
    "esnext",
    "--target",
    "es2022",
    "--moduleResolution",
    "bundler",
    "--lib",
    "es2023,dom",
  ],
  { cwd: root, stdio: "inherit" },
);
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }));

const { readSSE, EXTRACTORS, buildSystemPrompt } = await import(join(outDir, "providers.js"));

let failures = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`✗ ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

/** Builds a ReadableStream that emits the given strings as separate byte chunks. */
function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks, provider) {
  let text = "";
  for await (const event of readSSE(streamOf(chunks))) {
    const delta = EXTRACTORS[provider](event);
    if (delta) text += delta;
  }
  return text;
}

const anthropicFrame = (t) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } })}\n\n`;
const openaiFrame = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

// --- happy path, one frame per chunk ----------------------------------------
check(
  "anthropic: assembles deltas in order",
  await collect([anthropicFrame("Hello"), anthropicFrame(" world"), anthropicFrame("!")], "anthropic"),
  "Hello world!",
);
check(
  "openai: assembles deltas in order",
  await collect([openaiFrame("Hello"), openaiFrame(" world"), "data: [DONE]\n\n"], "openai"),
  "Hello world",
);

// --- the case that breaks naive parsers: a frame split mid-JSON -------------
const whole = anthropicFrame("split me");
check(
  "anthropic: frame split across two chunks mid-JSON",
  await collect([whole.slice(0, 30), whole.slice(30)], "anthropic"),
  "split me",
);
const openaiWhole = openaiFrame("split me too");
const thirds = [openaiWhole.slice(0, 10), openaiWhole.slice(10, 25), openaiWhole.slice(25)];
check("openai: frame split across three chunks", await collect(thirds, "openai"), "split me too");

// --- everything arriving as one chunk, and byte-by-byte ---------------------
const many = [anthropicFrame("a"), anthropicFrame("b"), anthropicFrame("c")].join("");
check("anthropic: several frames in one chunk", await collect([many], "anthropic"), "abc");
check("anthropic: one byte per chunk", await collect([...many], "anthropic"), "abc");

// --- protocol noise ---------------------------------------------------------
check(
  "CRLF line endings are handled",
  await collect([anthropicFrame("crlf").replace(/\n/g, "\r\n")], "anthropic"),
  "crlf",
);
check(
  "comments and keep-alives are ignored",
  await collect([": ping\n\n", anthropicFrame("kept"), ": ping\n\n"], "anthropic"),
  "kept",
);
check(
  "malformed frames do not abort the stream",
  await collect([anthropicFrame("good "), "data: {not json\n\n", anthropicFrame("still good")], "anthropic"),
  "good still good",
);
check(
  "non-text anthropic events are skipped",
  await collect(
    [`data: ${JSON.stringify({ type: "message_start" })}\n\n`, anthropicFrame("only text")],
    "anthropic",
  ),
  "only text",
);
check(
  "openai role-only delta contributes nothing",
  await collect([`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`, openaiFrame("x")], "openai"),
  "x",
);

// --- a final frame with no trailing blank line still counts -----------------
check(
  "trailing frame without blank line is flushed",
  await collect([anthropicFrame("first"), anthropicFrame("last").trimEnd()], "anthropic"),
  "firstlast",
);

// --- prompt construction ----------------------------------------------------
check("base prompt has no extras section", buildSystemPrompt().includes("Additional instructions"), false);
check(
  "custom instructions are appended",
  buildSystemPrompt("use British spelling").includes("- use British spelling"),
  true,
);
check("blank custom instructions are ignored", buildSystemPrompt("   ").includes("Additional instructions"), false);

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
