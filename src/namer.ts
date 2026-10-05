// Names new agents with a small model (README "Naming"). A failed naming never fails a dispatch: the
// namer resolves to null and the agent keeps its slug name.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "./config.ts";

/** The part of Pi's model registry the namer uses. */
export type NamingRegistry = Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth" | "streamSimple">;

/** Prompt → display name, or null when no usable name came back. Never rejects. */
export type Namer = (prompt: string) => Promise<string | null>;

export const MAX_NAME_LENGTH = 48;
export const NAMING_TIMEOUT_MS = 10_000;
// Generous for a few words, so models that cannot fully turn reasoning off still get to answer.
const MAX_TOKENS = 1024;
// Plenty to tell what a task is about; keeps huge pasted prompts cheap.
const MAX_PROMPT_CHARS = 4_000;

const SYSTEM_PROMPT = [
  "You name coding tasks for a dashboard of background agents.",
  "Reply with only a short title of 2 to 6 words that says what the task does, in sentence case,",
  "in the language of the task. No quotes, no trailing punctuation, no explanation.",
].join(" ");

// Characters stripped from both ends: quotes, markdown emphasis/code, heading marks, whitespace.
const EDGE_RE = /^[\s"'`*_#>]+|[\s"'`*_]+$/g;
const LABEL_RE = /^(title|name)\s*:\s*/i;
const TRAILING_PUNCT_RE = /[\s.!?,;:…]+$/;

/** One line of at most MAX_NAME_LENGTH chars (cut at a word boundary), or null when nothing is left. */
export function cleanName(raw: string): string | null {
  const line = raw.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let name = line.replace(/\s+/g, " ").replace(EDGE_RE, "").replace(LABEL_RE, "").replace(EDGE_RE, "");
  name = name.replace(TRAILING_PUNCT_RE, "").replace(EDGE_RE, "");
  if (name.length > MAX_NAME_LENGTH) {
    const cut = name.lastIndexOf(" ", MAX_NAME_LENGTH);
    name = (cut > 0 ? name.slice(0, cut) : name.slice(0, MAX_NAME_LENGTH)).replace(TRAILING_PUNCT_RE, "");
  }
  return /[\p{L}\p{N}]/u.test(name) ? name : null;
}

/** A namer for `spec` ("provider/id"), or why that model cannot be used. */
export function createNamer(
  registry: NamingRegistry,
  spec: string,
  opts: { timeoutMs?: number } = {},
): Namer | { error: string } {
  const parsed = parseModelSpec(spec);
  if (!parsed) return { error: `Invalid naming model "${spec}"; expected provider/id` };
  const model = registry.find(parsed.provider, parsed.id);
  if (!model) return { error: `Naming model ${spec} is not in the model catalog` };
  if (!registry.hasConfiguredAuth(model)) return { error: `Naming model ${spec} has no credentials` };
  const timeoutMs = opts.timeoutMs ?? NAMING_TIMEOUT_MS;

  return async (prompt) => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null); // also covers a provider that ignores the abort signal
      }, timeoutMs);
      timer.unref();
    });
    const ask = async (): Promise<string | null> => {
      const response = await registry
        .streamSimple(
          model,
          {
            systemPrompt: SYSTEM_PROMPT,
            messages: [{ role: "user", content: [{ type: "text", text: prompt.slice(0, MAX_PROMPT_CHARS) }], timestamp: Date.now() }],
          },
          { signal: controller.signal, maxTokens: MAX_TOKENS },
        )
        .result();
      if (response.stopReason !== "stop") return null;
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return cleanName(text);
    };
    try {
      return await Promise.race([ask(), timeout]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
