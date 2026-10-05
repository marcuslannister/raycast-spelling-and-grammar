# Spelling and Grammar

A local Raycast extension that replicates Raycast's built-in **Fix Spelling and Grammar** AI command, but calls Anthropic, OpenAI, or an OpenAI-compatible provider such as OpenRouter with your own API key instead of going through Raycast Pro.

It reads the text selected in the frontmost app, corrects it, shows you the changes, and pastes the result back over the selection when you confirm.

## Prerequisites

- Raycast
- Node.js 22+
- An API key for whichever provider you pick:
  - Anthropic — https://console.anthropic.com/settings/keys
  - OpenAI — https://platform.openai.com/api-keys
  - OpenRouter — https://openrouter.ai/keys

Raycast Pro is **not** required.

## Quick start

```bash
npm install
npm run dev        # builds and installs the extension into Raycast, then watches
```

`npm run dev` keeps running and hot-reloads on save. The command appears in Raycast as **Fix Spelling and Grammar** while it runs, and stays installed after you stop it.

On first run, set your provider and key in the extension preferences (`⌘,` on the command in Raycast's root search, or the **Open Extension Preferences** action inside the command).

## Configuration

| Preference | Type | Default | Notes |
|---|---|---|---|
| `provider` | dropdown | `anthropic` | Anthropic (Claude), OpenAI, or OpenAI-compatible (e.g. OpenRouter). |
| `anthropicApiKey` | password | — | Required when the provider is Anthropic. |
| `openaiApiKey` | password | — | Required when the provider is OpenAI. |
| `openaiCompatibleApiKey` | password | — | Required when the provider is OpenAI-compatible. |
| `openaiCompatibleBaseUrl` | textfield | `https://openrouter.ai/api/v1` | OpenAI-compatible only. `/chat/completions` is appended. |
| `model` | textfield | — | Override. Defaults to `claude-sonnet-5` / `gpt-4o` / `openai/gpt-4o`. |
| `customInstructions` | textfield | — | Appended to the prompt, e.g. `use British spelling`. |
| `showDiffFirst` | checkbox | off | Also show struck-through removals. |

Keys are stored in Raycast's encrypted preference store, not in this repo.

### Model overrides

Any model the provider exposes should work. The request asks for `temperature: 0` (deterministic corrections) and a token budget, but some models reject those — `gpt-5.6-luna`, for example, permits only the default temperature.

Rather than maintaining a list of which models allow what, the extension adapts: on a `400` that names one of `temperature`, `max_completion_tokens` or `max_tokens`, it drops that parameter and retries. `model`, `messages` and `stream` are never dropped, and a `400` blaming anything else surfaces immediately rather than retrying. The cost is one wasted round trip the first time you use such a model.

To see which models your key can actually use:

```bash
curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | jq -r '.data[].id' | sort
```

## Usage

1. Select text in any app.
2. Run **Fix Spelling and Grammar**.
3. The correction streams in, then settles into the final text with only the changed words highlighted, and a `227 Characters • 37 Words • 2 Changes` footer.

| Key | Action |
|---|---|
| `⏎` | Paste the corrected text over the selection |
| `⌘⇧C` | Copy the corrected text |
| `⌘D` | Also show what was removed (`~~struck through~~`) |
| `⌘R` | Retry |

If no text is selected, the extension falls back to the clipboard and says so in the sidebar. Nothing is pasted until you press `⏎`.

## How it differs from Raycast's built-in command

- Your API key, your bill, your choice of model.
- Nothing is pasted until you press `⏎`, and `⌘D` can show what the model removed — which the built-in cannot.
- The prompt instructs the model to treat the selected text as data, not instructions, so selected text containing something like "ignore previous instructions" is proofread rather than obeyed.

### Highlight fidelity

The built-in tints changed words green. Raycast's Detail Markdown has **no text or background colour**, so changed words are rendered as inline-code spans instead — the only construct that produces a tinted background. Punctuation is kept out of the span (`` `quickly` ``. not `` `quickly.` ``) to match the built-in, and the footer counts match it too: a substitution is one change, not two.

## Development

```bash
npm run dev         # develop against Raycast with hot reload
npm test            # diff, SSE parsing, request shape, and error mapping checks
npm run typecheck   # tsc --noEmit
npm run lint        # ray lint  (npm run fix-lint to autofix)
npm run build       # production build
npm run icon        # regenerate assets/icon.png
```

### Layout

| Path | Contents |
|---|---|
| `src/fix-spelling-and-grammar.tsx` | The command: input, streaming state, Detail view, actions. |
| `src/providers.ts` | Prompt, per-provider request shapes, SSE reader, error mapping. |
| `src/diff.ts` | Word-level LCS diff rendered as Raycast-safe Markdown. |
| `scripts/make-icon.mjs` | Generates the icon PNG with no image dependencies. |
| `scripts/test-*.mjs` | Dependency-free test scripts (`npm test`). |

The tests transpile `src/diff.ts` and `src/providers.ts` to a temp directory and run them under plain Node, stubbing `fetch`. No API key is needed and no network calls are made.

### Testing notes

`src/providers.ts` exports `readSSE` and `EXTRACTORS` purely so the stream parsing can be tested in isolation — the frame-split-mid-JSON case is the one that breaks naive SSE parsers, and it is covered.

## License

MIT
