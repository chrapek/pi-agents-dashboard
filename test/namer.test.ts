import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, createNamer, MAX_NAME_LENGTH, type NamingRegistry } from "../src/namer.ts";

interface Call {
  model: unknown;
  context: { systemPrompt?: string; messages: { content: { text: string }[] }[] };
  options: { signal?: AbortSignal; maxTokens?: number; reasoning?: unknown };
}

type Reply = { stopReason: string; text?: string; errorMessage?: string } | "hang" | "throw";

function fakeRegistry(reply: Reply, opts: { known?: boolean; auth?: boolean } = {}) {
  const calls: Call[] = [];
  const model = { provider: "openai", id: "gpt-6-luna" };
  const registry: NamingRegistry = {
    find: (provider, id) => ((opts.known ?? true) && provider === "openai" && id === "gpt-6-luna" ? (model as never) : undefined),
    hasConfiguredAuth: () => opts.auth ?? true,
    streamSimple: ((m: unknown, context: Call["context"], options: Call["options"]) => {
      calls.push({ model: m, context, options });
      return {
        result: () => {
          if (reply === "throw") return Promise.reject(new Error("boom"));
          if (reply === "hang") {
            return new Promise((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
          }
          return Promise.resolve({
            stopReason: reply.stopReason,
            errorMessage: reply.errorMessage,
            content: reply.text === undefined ? [] : [{ type: "text", text: reply.text }],
          });
        },
      };
    }) as never,
  };
  return { registry, calls, model };
}

// --- cleanName ------------------------------------------------------------------

test("cleanName keeps a plain title", () => {
  assert.equal(cleanName("Fix login redirect"), "Fix login redirect");
});

test("cleanName takes the first non-empty line and collapses whitespace", () => {
  assert.equal(cleanName("\n\n  Fix   login\tredirect  \nsecond line"), "Fix login redirect");
});

test("cleanName strips wrapping quotes, markdown, a Title: label and trailing punctuation", () => {
  assert.equal(cleanName('"Fix login redirect."'), "Fix login redirect");
  assert.equal(cleanName("`Add dark mode`"), "Add dark mode");
  assert.equal(cleanName("**Refactor auth module**"), "Refactor auth module");
  assert.equal(cleanName("Title: Speed up CI!"), "Speed up CI");
  assert.equal(cleanName("# Upgrade React"), "Upgrade React");
});

test("cleanName cuts long names at a word boundary", () => {
  const long = "Investigate intermittent failures in the payment webhook retry pipeline today";
  const name = cleanName(long)!;
  assert.ok(name.length <= MAX_NAME_LENGTH, name);
  assert.ok(long.startsWith(name));
  assert.ok(!name.endsWith(" "));
  assert.equal(long[name.length], " ");
});

test("cleanName hard-cuts a single overlong word", () => {
  assert.equal(cleanName("x".repeat(100)), "x".repeat(MAX_NAME_LENGTH));
});

test("cleanName returns null for empty or punctuation-only output", () => {
  assert.equal(cleanName(""), null);
  assert.equal(cleanName("  \n "), null);
  assert.equal(cleanName('""'), null);
  assert.equal(cleanName("..."), null);
});

// --- createNamer ----------------------------------------------------------------

test("createNamer reports an invalid spec, an unknown model, or missing credentials", () => {
  assert.match((createNamer(fakeRegistry({ stopReason: "stop" }).registry, "nope") as { error: string }).error, /provider\/id/);
  assert.match(
    (createNamer(fakeRegistry({ stopReason: "stop" }, { known: false }).registry, "openai/gpt-6-luna") as { error: string }).error,
    /not in the model catalog/,
  );
  assert.match(
    (createNamer(fakeRegistry({ stopReason: "stop" }, { auth: false }).registry, "openai/gpt-6-luna") as { error: string }).error,
    /no credentials/,
  );
});

test("the namer sends the prompt to the model without reasoning and returns the cleaned title", async () => {
  const { registry, calls, model } = fakeRegistry({ stopReason: "stop", text: '"Fix login redirect."' });
  const namer = createNamer(registry, "openai/gpt-6-luna");
  assert.equal(typeof namer, "function");
  const name = await (namer as (p: string) => Promise<string | null>)("the login page redirects to /404 after auth, fix it");
  assert.equal(name, "Fix login redirect");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, model);
  assert.ok(calls[0]!.context.systemPrompt);
  assert.match(calls[0]!.context.messages[0]!.content[0]!.text, /redirects to \/404/);
  assert.equal(calls[0]!.options.reasoning, undefined);
  assert.ok(calls[0]!.options.signal instanceof AbortSignal);
  assert.ok((calls[0]!.options.maxTokens ?? 0) > 0);
});

test("the namer truncates very long prompts before sending them", async () => {
  const { registry, calls } = fakeRegistry({ stopReason: "stop", text: "Big task" });
  const namer = createNamer(registry, "openai/gpt-6-luna") as (p: string) => Promise<string | null>;
  await namer("y".repeat(100_000));
  assert.ok(calls[0]!.context.messages[0]!.content[0]!.text.length < 10_000);
});

test("the namer returns null on a model error, a thrown error, a cut-off answer, or empty output", async () => {
  for (const reply of [
    { stopReason: "error", errorMessage: "rate limited" },
    { stopReason: "aborted" },
    { stopReason: "length", text: "Fix lo" },
    { stopReason: "stop", text: "   " },
    "throw" as const,
  ]) {
    const namer = createNamer(fakeRegistry(reply).registry, "openai/gpt-6-luna") as (p: string) => Promise<string | null>;
    assert.equal(await namer("do things"), null, JSON.stringify(reply));
  }
});

test("the namer gives up after its timeout and returns null", async () => {
  const namer = createNamer(fakeRegistry("hang").registry, "openai/gpt-6-luna", { timeoutMs: 30 }) as (
    p: string,
  ) => Promise<string | null>;
  const started = Date.now();
  assert.equal(await namer("do things"), null);
  assert.ok(Date.now() - started < 2_000);
});
