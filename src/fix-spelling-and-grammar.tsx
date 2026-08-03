import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Detail,
  Icon,
  Keyboard,
  getPreferenceValues,
  getSelectedText,
  openExtensionPreferences,
  showHUD,
} from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { DiffResult, asMarkdownText, diffMarkdown, restoreDroppedEmoji } from "./diff";
import {
  DEFAULT_MODELS,
  KEY_PREFERENCE,
  PROVIDER_TITLES,
  Provider,
  ProviderError,
  buildSystemPrompt,
  streamCorrection,
} from "./providers";

interface Prefs {
  provider: Provider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  model?: string;
  customInstructions?: string;
  showDiffFirst: boolean;
}

type Origin = "selection" | "clipboard";

export default function FixSpellingAndGrammar() {
  const prefs = getPreferenceValues<Prefs>();
  const provider = prefs.provider;
  const model = prefs.model?.trim() || DEFAULT_MODELS[provider];
  const apiKey = (provider === "anthropic" ? prefs.anthropicApiKey : prefs.openaiApiKey)?.trim();

  const [original, setOriginal] = useState("");
  const [origin, setOrigin] = useState<Origin>("selection");
  const [corrected, setCorrected] = useState("");
  const [restored, setRestored] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showDiff, setShowDiff] = useState(prefs.showDiffFirst);
  const [attempt, setAttempt] = useState(0);

  const abortRef = useRef<AbortController | undefined>(undefined);

  // Re-runs only when Retry bumps `attempt`; preferences are fixed for the command's lifetime.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    void run({ provider, model, apiKey, customInstructions: prefs.customInstructions, signal: controller.signal });

    return () => controller.abort();
  }, [attempt, provider, model, apiKey, prefs.customInstructions]);

  async function run(options: {
    provider: Provider;
    model: string;
    apiKey?: string;
    customInstructions?: string;
    signal: AbortSignal;
  }) {
    setIsLoading(true);
    setError(undefined);
    setCorrected("");
    setRestored([]);

    if (!options.apiKey) {
      setError(
        `No ${PROVIDER_TITLES[options.provider]} API key configured. Add one under \`${
          KEY_PREFERENCE[options.provider]
        }\` in the extension preferences, or switch the provider.`,
      );
      setIsLoading(false);
      return;
    }

    const input = await readInput();
    if (!input) {
      setError("Nothing to correct. Select some text in another app, or copy it to the clipboard, then run again.");
      setIsLoading(false);
      return;
    }

    setOriginal(input.text);
    setOrigin(input.origin);

    try {
      const result = await streamCorrection({
        provider: options.provider,
        apiKey: options.apiKey,
        model: options.model,
        text: input.text,
        systemPrompt: buildSystemPrompt(options.customInstructions),
        signal: options.signal,
        onDelta: (delta) => setCorrected((current) => current + delta),
      });

      // Models often echo the surrounding whitespace inconsistently; keep the original's.
      const aligned = matchOuterWhitespace(input.text, result);
      // Models drop emoji even when told not to, so put them back rather than trusting the prompt.
      const repaired = restoreDroppedEmoji(input.text, aligned);

      setCorrected(repaired.text);
      setRestored(repaired.restored);
      setIsLoading(false);
    } catch (caught) {
      if (options.signal.aborted) return;
      setError(caught instanceof ProviderError ? caught.message : String((caught as Error)?.message ?? caught));
      setIsLoading(false);
    }
  }

  const diff = useMemo(
    () => (isLoading || !corrected ? undefined : diffMarkdown(original, corrected)),
    [isLoading, original, corrected],
  );

  const markdown = buildMarkdown({ isLoading, error, corrected, showDiff, diff, restored });

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      navigationTitle={isLoading ? "Fixing Spelling and Grammar…" : "Fix Spelling and Grammar"}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Provider" text={PROVIDER_TITLES[provider]} icon={Icon.Cloud} />
          <Detail.Metadata.Label title="Model" text={model} />
          <Detail.Metadata.Label
            title="Source"
            text={origin === "selection" ? "Selected text" : "Clipboard"}
            icon={origin === "selection" ? Icon.TextCursor : Icon.Clipboard}
          />
          <Detail.Metadata.Separator />
          {error ? (
            <Detail.Metadata.TagList title="Status">
              <Detail.Metadata.TagList.Item text="Failed" color={Color.Red} />
            </Detail.Metadata.TagList>
          ) : (
            <Detail.Metadata.TagList title="Changes">
              <Detail.Metadata.TagList.Item
                text={changesLabel(isLoading, diff?.changes)}
                color={changesColor(isLoading, diff?.changes)}
              />
            </Detail.Metadata.TagList>
          )}
          <Detail.Metadata.Label title="Words" text={diff ? String(diff.words) : "—"} />
          <Detail.Metadata.Label title="Characters" text={diff ? String(diff.characters) : "—"} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {corrected && !isLoading ? (
            <ActionPanel.Section>
              <Action
                title="Paste Corrected Text"
                icon={Icon.Clipboard}
                onAction={async () => {
                  await Clipboard.paste(corrected);
                  await showHUD("Pasted corrected text");
                }}
              />
              <Action.CopyToClipboard
                title="Copy Corrected Text"
                content={corrected}
                shortcut={Keyboard.Shortcut.Common.Copy}
              />
              <Action
                title={showDiff ? "Hide Removed Text" : "Show Removed Text"}
                icon={showDiff ? Icon.Text : Icon.Switch}
                shortcut={{ modifiers: ["cmd"], key: "d" }}
                onAction={() => setShowDiff((current) => !current)}
              />
            </ActionPanel.Section>
          ) : null}
          <ActionPanel.Section>
            <Action
              title="Retry"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={() => {
                abortRef.current?.abort();
                setAttempt((current) => current + 1);
              }}
            />
            {/* No shortcut: Common.Copy (⌘⇧C) is taken by the corrected text above. */}
            {original ? <Action.CopyToClipboard title="Copy Original Text" content={original} /> : null}
            <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

async function readInput(): Promise<{ text: string; origin: Origin } | undefined> {
  try {
    const selected = await getSelectedText();
    if (selected.trim()) return { text: selected, origin: "selection" };
  } catch {
    // No selection available (e.g. the frontmost app exposes none) — fall through.
  }

  const clipboard = await Clipboard.readText();
  return clipboard?.trim() ? { text: clipboard, origin: "clipboard" } : undefined;
}

/** Reinstates the original leading/trailing whitespace so pasting does not shift layout. */
function matchOuterWhitespace(original: string, corrected: string): string {
  const leading = original.match(/^\s*/)?.[0] ?? "";
  const trailing = original.match(/\s*$/)?.[0] ?? "";
  return `${leading}${corrected.trim()}${trailing}`;
}

function buildMarkdown(args: {
  isLoading: boolean;
  error?: string;
  corrected: string;
  showDiff: boolean;
  diff?: DiffResult;
  restored: string[];
}): string {
  if (args.error) {
    return `# Could not fix the text\n\n${args.error}\n\n_Press \`⌘R\` to retry, or open the action panel to change preferences._`;
  }

  if (args.isLoading) {
    return args.corrected ? asMarkdownText(args.corrected) : "_Reading the text and calling the model…_";
  }

  if (!args.diff) return asMarkdownText(args.corrected);

  const body = args.showDiff ? args.diff.full : args.diff.highlighted;
  const footer = [statsLine(args.diff), restoredNote(args.restored), removalWarning(args.diff, args.showDiff)]
    .filter(Boolean)
    .join("\n\n");

  return `${body}\n\n---\n\n${footer}`;
}

/** Says so when the repair pass had to intervene, rather than fixing it silently. */
function restoredNote(restored: string[]): string | undefined {
  if (restored.length === 0) return undefined;

  const listed = restored.slice(0, 8).join(" ");
  const rest = restored.length > 8 ? ` and ${restored.length - 8} more` : "";
  const subject = restored.length === 1 ? "emoji" : "emoji";

  return `↩︎ **Put back ${restored.length} ${subject} the model dropped:** ${listed}${rest}`;
}

/**
 * Warns when the model deleted something outright. Without this the highlighted
 * view shows a clean result and the loss is only discovered after pasting.
 */
function removalWarning(diff: DiffResult, showDiff: boolean): string | undefined {
  if (diff.removed.length === 0) return undefined;

  const listed = diff.removed
    .slice(0, 5)
    .map((text) => `\`${text}\``)
    .join(", ");
  const rest = diff.removed.length > 5 ? `, and ${diff.removed.length - 5} more` : "";
  const hint = showDiff ? "struck through above" : "press `⌘D` to see them in place";

  return `⚠︎ **Removed without replacement:** ${listed}${rest} — ${hint}.`;
}

/** Mirrors the built-in command's footer: `227 Characters • 37 Words • 2 Changes`. */
function statsLine(diff: DiffResult): string {
  const parts = [plural(diff.characters, "Character"), plural(diff.words, "Word")];

  if (diff.truncated) {
    parts.push("diff skipped (text too long)");
  } else {
    parts.push(diff.changes === 0 ? "No Changes" : plural(diff.changes, "Change"));
  }

  return `_${parts.join(" • ")}_`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function changesLabel(isLoading: boolean, changes?: number): string {
  if (isLoading) return "Working…";
  if (changes === undefined) return "—";
  if (changes < 0) return "Too long to diff";
  return changes === 0 ? "None" : plural(changes, "Change");
}

function changesColor(isLoading: boolean, changes?: number): Color {
  if (isLoading || changes === undefined) return Color.SecondaryText;
  if (changes < 0) return Color.SecondaryText;
  return changes === 0 ? Color.Green : Color.Yellow;
}
