// User config — small persisted preferences under ~/.coder/config.json so a chosen model
// sticks across restarts. Precedence (high→low): --model / CODER_MODEL > this file > tier
// default. Best-effort: a missing or unreadable file is just "no preferences".
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PATH = join(homedir(), ".coder", "config.json");

export interface UserConfig {
  /** Preferred model id (overrides the tier default; flags/env still win). */
  model?: string;
}

export async function readUserConfig(): Promise<UserConfig> {
  try {
    return JSON.parse(await readFile(PATH, "utf8")) as UserConfig;
  } catch {
    return {};
  }
}

export async function writeUserConfig(patch: Partial<UserConfig>): Promise<void> {
  const next = { ...(await readUserConfig()), ...patch };
  await mkdir(dirname(PATH), { recursive: true });
  await writeFile(PATH, `${JSON.stringify(next, null, 2)}\n`);
}
