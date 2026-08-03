/**
 * End-to-end tests for streamCorrection with a stubbed global fetch: verifies
 * the request each provider sends, delta callbacks, and error mapping.
 *
 * Run with: node scripts/test-request.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "raycast-spelling-request-"));

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

const { streamCorrection, ProviderError, buildSystemPrompt } = await import(join(outDir, "providers.js"));

let failures = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`✗ ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

function sseBody(frames) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

const anthropicFrame = (t) =>
  `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } })}\n\n`;
const openaiFrame = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

/** Installs a fetch stub, runs fn, restores, and returns [result, capturedRequest]. */
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return handler(url, init);
  };
  try {
    return [await fn(), captured];
  } finally {
    globalThis.fetch = original;
  }
}

const baseOptions = {
  text: "Their going home.",
  systemPrompt: buildSystemPrompt(),
  signal: new AbortController().signal,
  onDelta: () => {},
};

// --- Anthropic request shape -------------------------------------------------
{
  const deltas = [];
  const [result, request] = await withFetch(
    () => new Response(sseBody([anthropicFrame("They're "), anthropicFrame("going home.")]), { status: 200 }),
    () =>
      streamCorrection({
        ...baseOptions,
        provider: "anthropic",
        apiKey: "sk-ant-test",
        model: "claude-sonnet-5",
        onDelta: (d) => deltas.push(d),
      }),
  );

  const body = JSON.parse(request.init.body);
  check("anthropic: url", request.url, "https://api.anthropic.com/v1/messages");
  check("anthropic: auth header", request.init.headers["x-api-key"], "sk-ant-test");
  check("anthropic: version header", request.init.headers["anthropic-version"], "2023-06-01");
  check("anthropic: model passed through", body.model, "claude-sonnet-5");
  check("anthropic: streaming enabled", body.stream, true);
  check("anthropic: temperature pinned to 0", body.temperature, 0);
  check("anthropic: system prompt is top-level", typeof body.system, "string");
  check("anthropic: user text is the only message", body.messages, [{ role: "user", content: "Their going home." }]);
  check("anthropic: assembled result", result, "They're going home.");
  check("anthropic: deltas streamed incrementally", deltas, ["They're ", "going home."]);
}

// --- OpenAI request shape ----------------------------------------------------
{
  const [result, request] = await withFetch(
    () => new Response(sseBody([openaiFrame("They're going home."), "data: [DONE]\n\n"]), { status: 200 }),
    () => streamCorrection({ ...baseOptions, provider: "openai", apiKey: "sk-oai-test", model: "gpt-4o" }),
  );

  const body = JSON.parse(request.init.body);
  check("openai: url", request.url, "https://api.openai.com/v1/chat/completions");
  check("openai: auth header", request.init.headers.authorization, "Bearer sk-oai-test");
  check("openai: model passed through", body.model, "gpt-4o");
  check("openai: streaming enabled", body.stream, true);
  check("openai: system prompt is the first message", body.messages[0].role, "system");
  check("openai: user text is the second message", body.messages[1], { role: "user", content: "Their going home." });
  check("openai: assembled result", result, "They're going home.");
}

// --- max token budget scales with input -------------------------------------
{
  const long = "word ".repeat(20000); // 100k chars
  const [, request] = await withFetch(
    () => new Response(sseBody([anthropicFrame("ok")]), { status: 200 }),
    () => streamCorrection({ ...baseOptions, text: long, provider: "anthropic", apiKey: "k", model: "m" }),
  );
  check("token budget is capped", JSON.parse(request.init.body).max_tokens, 16000);

  const [, small] = await withFetch(
    () => new Response(sseBody([anthropicFrame("ok")]), { status: 200 }),
    () => streamCorrection({ ...baseOptions, text: "hi", provider: "anthropic", apiKey: "k", model: "m" }),
  );
  check("token budget has a floor", JSON.parse(small.init.body).max_tokens, 1024);
}

// --- unsupported parameters are dropped and the call retried ----------------
{
  // The real message from gpt-5.6-luna.
  const rejection = JSON.stringify({
    error: { message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported." },
  });

  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? new Response(rejection, { status: 400 })
      : new Response(sseBody([openaiFrame("Corrected.")]), { status: 200 });
  };

  let result;
  try {
    result = await streamCorrection({
      ...baseOptions,
      provider: "openai",
      apiKey: "k",
      model: "gpt-5.6-luna",
    });
  } finally {
    globalThis.fetch = original;
  }

  check("temperature rejection triggers exactly one retry", bodies.length, 2);
  check("first attempt included temperature", "temperature" in bodies[0], true);
  check("retry dropped temperature", "temperature" in bodies[1], false);
  check("retry kept the model", bodies[1].model, "gpt-5.6-luna");
  check("retry kept the messages", bodies[1].messages.length, 2);
  check("retry kept streaming on", bodies[1].stream, true);
  check("retry kept the token budget", "max_completion_tokens" in bodies[1], true);
  check("retry returns the correction", result, "Corrected.");
}

// --- a model that rejects two parameters in turn -----------------------------
{
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return new Response('{"error":{"message":"temperature is not supported"}}', { status: 400 });
    if (bodies.length === 2)
      return new Response('{"error":{"message":"max_completion_tokens is not supported"}}', { status: 400 });
    return new Response(sseBody([openaiFrame("ok")]), { status: 200 });
  };

  let result;
  try {
    result = await streamCorrection({ ...baseOptions, provider: "openai", apiKey: "k", model: "m" });
  } finally {
    globalThis.fetch = original;
  }

  check("two rejections cause two retries", bodies.length, 3);
  check("both offending params are gone", ["temperature", "max_completion_tokens"].some((p) => p in bodies[2]), false);
  check("essentials survive both retries", [bodies[2].model, bodies[2].stream], ["m", true]);
  check("second retry succeeds", result, "ok");
}

// --- a 400 blaming something undroppable must not loop -----------------------
{
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"error":{"message":"messages: invalid role"}}', { status: 400 });
  };

  let message;
  try {
    await streamCorrection({ ...baseOptions, provider: "openai", apiKey: "k", model: "m" });
  } catch (caught) {
    message = caught.message;
  } finally {
    globalThis.fetch = original;
  }

  check("an undroppable 400 is not retried", calls, 1);
  check("an undroppable 400 surfaces to the user", message, "400: messages: invalid role");
}

// --- non-400 failures are never retried -------------------------------------
{
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"error":{"message":"temperature is fine, server is not"}}', { status: 500 });
  };

  try {
    await streamCorrection({ ...baseOptions, provider: "openai", apiKey: "k", model: "m" });
  } catch {
    // expected
  } finally {
    globalThis.fetch = original;
  }

  check("a 500 mentioning a param is not retried", calls, 1);
}

// --- error mapping -----------------------------------------------------------
async function errorFor(status, body) {
  try {
    await withFetch(
      () => new Response(body, { status }),
      () => streamCorrection({ ...baseOptions, provider: "anthropic", apiKey: "k", model: "m" }),
    );
    return "no error thrown";
  } catch (caught) {
    return caught instanceof ProviderError ? caught.message : `wrong type: ${caught}`;
  }
}

check(
  "401 explains the key is wrong",
  (await errorFor(401, '{"error":{"message":"invalid x-api-key"}}')).includes("Authentication failed (401)"),
  true,
);
check("403 is treated as auth too", (await errorFor(403, "{}")).includes("Authentication failed (403)"), true);
check("429 explains rate limiting", (await errorFor(429, "{}")).includes("Rate limited"), true);
check(
  "404 surfaces the provider message",
  await errorFor(404, '{"error":{"message":"model: bogus"}}'),
  "Model not found (404). model: bogus",
);
check(
  "500 surfaces status and detail",
  await errorFor(500, '{"error":{"message":"overloaded"}}'),
  "500: overloaded",
);
check("non-JSON error body still reports", (await errorFor(502, "<html>bad gateway</html>")).includes("502:"), true);

// --- empty stream is an error, not a silent success -------------------------
{
  let message = "no error thrown";
  try {
    await withFetch(
      () => new Response(sseBody(["data: [DONE]\n\n"]), { status: 200 }),
      () => streamCorrection({ ...baseOptions, provider: "openai", apiKey: "k", model: "m" }),
    );
  } catch (caught) {
    message = caught.message;
  }
  check("empty response is rejected", message, "The model returned an empty response.");
}

// --- the abort signal is forwarded to fetch ---------------------------------
{
  const controller = new AbortController();
  const [, request] = await withFetch(
    () => new Response(sseBody([anthropicFrame("ok")]), { status: 200 }),
    () =>
      streamCorrection({ ...baseOptions, signal: controller.signal, provider: "anthropic", apiKey: "k", model: "m" }),
  );
  check("abort signal is passed to fetch", request.init.signal === controller.signal, true);
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
