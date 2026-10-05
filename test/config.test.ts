import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NAMING_MODEL, ENV_NAMING_MODEL, parseModelSpec, resolveConfig } from "../src/config.ts";

test("defaults when neither env nor settings say anything", () => {
  assert.deepEqual(resolveConfig({ env: {}, settings: {} }), {
    config: { namingModel: DEFAULT_NAMING_MODEL },
    errors: [],
  });
  assert.equal(DEFAULT_NAMING_MODEL, "openai/gpt-6-luna");
});

test("settings.agentDashboard.namingModel overrides the default", () => {
  const settings = { agentDashboard: { namingModel: "anthropic/claude-haiku-4-5" } };
  assert.deepEqual(resolveConfig({ env: {}, settings }).config, { namingModel: "anthropic/claude-haiku-4-5" });
});

test("env var overrides settings", () => {
  const settings = { agentDashboard: { namingModel: "anthropic/claude-haiku-4-5" } };
  const env = { [ENV_NAMING_MODEL]: " openrouter/openai/gpt-5-mini " };
  assert.deepEqual(resolveConfig({ env, settings }).config, { namingModel: "openrouter/openai/gpt-5-mini" });
});

test('"off" (any case) disables naming, in settings or env', () => {
  assert.equal(resolveConfig({ env: {}, settings: { agentDashboard: { namingModel: "off" } } }).config.namingModel, null);
  assert.equal(resolveConfig({ env: { [ENV_NAMING_MODEL]: "OFF" }, settings: {} }).config.namingModel, null);
  assert.equal(resolveConfig({ env: { [ENV_NAMING_MODEL]: "off" }, settings: { agentDashboard: { namingModel: "a/b" } } }).config.namingModel, null);
});

test("blank env var falls through to settings", () => {
  const settings = { agentDashboard: { namingModel: "a/b" } };
  assert.equal(resolveConfig({ env: { [ENV_NAMING_MODEL]: "  " }, settings }).config.namingModel, "a/b");
});

test("invalid values are reported and naming is turned off for them", () => {
  const bad = resolveConfig({ env: {}, settings: { agentDashboard: { namingModel: "no-slash" } } });
  assert.equal(bad.config.namingModel, null);
  assert.match(bad.errors.join(), /agentDashboard\.namingModel/);

  const badType = resolveConfig({ env: {}, settings: { agentDashboard: { namingModel: 42 } } });
  assert.equal(badType.config.namingModel, null);
  assert.equal(badType.errors.length, 1);

  const badEnv = resolveConfig({ env: { [ENV_NAMING_MODEL]: "nope" }, settings: {} });
  assert.equal(badEnv.config.namingModel, null);
  assert.match(badEnv.errors.join(), new RegExp(ENV_NAMING_MODEL));
});

test("a non-object block is reported and ignored", () => {
  const r = resolveConfig({ env: {}, settings: { agentDashboard: "x" } });
  assert.deepEqual(r.config, { namingModel: DEFAULT_NAMING_MODEL });
  assert.match(r.errors.join(), /agentDashboard must be an object/);
});

test("missing or odd settings values are tolerated", () => {
  assert.deepEqual(resolveConfig({ env: {}, settings: undefined }).config, { namingModel: DEFAULT_NAMING_MODEL });
  assert.deepEqual(resolveConfig({ env: {}, settings: null }).config, { namingModel: DEFAULT_NAMING_MODEL });
});

test("parseModelSpec splits on the first slash", () => {
  assert.deepEqual(parseModelSpec("openai/gpt-6-luna"), { provider: "openai", id: "gpt-6-luna" });
  assert.deepEqual(parseModelSpec("openrouter/openai/gpt-5-mini"), { provider: "openrouter", id: "openai/gpt-5-mini" });
  assert.equal(parseModelSpec("nope"), undefined);
  assert.equal(parseModelSpec("/x"), undefined);
  assert.equal(parseModelSpec("x/"), undefined);
});
