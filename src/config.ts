// Extension configuration: the `agentDashboard` block of Pi's settings.json (global or project), with
// environment variable overrides. Every option lives here; each resolves independently as
// env var > settings > built-in default.

/** Key of the extension's block in Pi's settings.json. */
export const SETTINGS_KEY = "agentDashboard";

/** Small model that names new agents from their prompt; "off" disables naming. */
export const DEFAULT_NAMING_MODEL = "openai/gpt-6-luna";
export const ENV_NAMING_MODEL = "PI_AGENTS_NAMING_MODEL";
const OFF = "off";

export interface DashboardConfig {
  /** "provider/id" of the naming model, or null when naming is off. */
  namingModel: string | null;
}

export interface ConfigSources {
  env: Record<string, string | undefined>;
  /** `pi.getSettings()`; anything else is tolerated. */
  settings: unknown;
}

export interface ModelSpec {
  provider: string;
  id: string;
}

/** "provider/id", split on the first slash so ids like "openrouter/openai/gpt-5-mini" survive. */
export function parseModelSpec(raw: string): ModelSpec | undefined {
  const spec = raw.trim();
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A model option value: a "provider/id" string, null for "off", or an error. */
function parseModelOption(raw: unknown, source: string): { value: string | null } | { error: string } {
  const text = typeof raw === "string" ? raw.trim() : undefined;
  if (text !== undefined && text.toLowerCase() === OFF) return { value: null };
  if (text !== undefined && parseModelSpec(text)) return { value: text };
  return { error: `${source} must be "provider/id" or "${OFF}"` };
}

/** Resolves every option; invalid values are reported in `errors` and turn their feature off. */
export function resolveConfig({ env, settings }: ConfigSources): { config: DashboardConfig; errors: string[] } {
  const errors: string[] = [];
  let block: Record<string, unknown> = {};
  const rawBlock = isRecord(settings) ? settings[SETTINGS_KEY] : undefined;
  if (isRecord(rawBlock)) block = rawBlock;
  else if (rawBlock !== undefined) errors.push(`${SETTINGS_KEY} must be an object`);

  let namingModel: string | null = DEFAULT_NAMING_MODEL;
  const envModel = env[ENV_NAMING_MODEL]?.trim();
  const [raw, source] = envModel
    ? [envModel, ENV_NAMING_MODEL]
    : [block.namingModel, `${SETTINGS_KEY}.namingModel`];
  if (raw !== undefined) {
    const parsed = parseModelOption(raw, source);
    if ("error" in parsed) {
      errors.push(parsed.error);
      namingModel = null;
    } else {
      namingModel = parsed.value;
    }
  }

  return { config: { namingModel }, errors };
}
