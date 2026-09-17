const PREFIX = "CRACK_BOT_";
const LEGACY_PREFIX = "JEV_";

/**
 * Read a crack-bot setting: `CRACK_BOT_<name>`, falling back to the legacy
 * `JEV_<name>` so existing Grok Bot server entries keep working.
 */
export function setting(name: string): string | undefined {
  const value = process.env[PREFIX + name] ?? process.env[LEGACY_PREFIX + name];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function settingIs(name: string, expected: string): boolean {
  return setting(name) === expected;
}
