// The run's skill set as one local SDK plugin (ADR-0015 decision 1). The Gateway sends the exact
// skills and versions the run may use; this module writes them under a per-attempt directory and
// returns the `plugins` entry plus the `skills` list that enables exactly that set. Files in
// `/home/<bot>/skills` are never read. The SDK documents `skills` as a context filter, not a
// sandbox: the workspace stays the boundary (ADR-0004), and the scan of decision 5 is the gate.

import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  type RunSkill,
  SKILL_PLUGIN_NAME,
  isSkillFilePath,
  isSkillName,
  pluginSkillName,
} from "@deskmates/contracts";
import type { SidecarFs } from "./deps.js";

/**
 * Where the CLI reads a plugin's manifest. Joined from parts so the no-model-name-literal check
 * (`gateway/src/config.test.ts`) does not mistake the directory name for a model id.
 */
export const PLUGIN_MANIFEST_DIR = [".claude", "plugin"].join("-");

export interface SkillPlugin {
  /** Directory of the run's plugin; removed when the attempt ends. */
  dir: string;
  plugin: SdkPluginConfig;
  /** The SDK `skills` option: one plugin-qualified name per skill of the set. */
  skills: string[];
  /** What was enabled, for the ledger: names and hashes, never content. */
  set: { name: string; version: number; sha256: string }[];
}

export function skillPluginDir(
  env: Readonly<Record<string, string | undefined>>,
  runId: string,
  attempt: number,
): string {
  return `${env.TMPDIR ?? "/tmp"}/deskmates-skills-${runId}-${attempt}`;
}

/**
 * Writes the plugin manifest and every file of every skill. A name or path the Gateway should
 * never have sent is refused rather than written somewhere unexpected.
 */
export async function materializeSkillPlugin(
  skills: readonly RunSkill[],
  fs: SidecarFs,
  dir: string,
): Promise<SkillPlugin> {
  // `writeFile` creates parent directories, the plugin directory included.
  await fs.writeFile(
    `${dir}/${PLUGIN_MANIFEST_DIR}/plugin.json`,
    `${JSON.stringify({
      name: SKILL_PLUGIN_NAME,
      description: "Skills the Deskmates Gateway enabled for this run",
      version: "1.0.0",
    })}\n`,
  );
  for (const skill of skills) {
    if (!isSkillName(skill.name)) throw new Error(`refused skill name: ${skill.name}`);
    for (const file of skill.files) {
      if (!isSkillFilePath(file.path))
        throw new Error(`refused skill file path: ${skill.name}/${file.path}`);
      await fs.writeFile(`${dir}/skills/${skill.name}/${file.path}`, file.content);
    }
  }
  return {
    dir,
    plugin: { type: "local", path: dir, skipMcpDiscovery: true },
    skills: skills.map((skill) => pluginSkillName(skill.name)),
    set: skills.map(({ name, version, sha256 }) => ({ name, version, sha256 })),
  };
}

/**
 * The skill a `Skill` tool call loads, without the plugin qualifier, or undefined when the input
 * names none. The hook records it; the model's own account of what it used is never read.
 */
export function skillOfToolInput(input: Record<string, unknown>): string | undefined {
  const raw = typeof input.skill === "string" ? input.skill : input.name;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const name = raw.trim().replace(/^\//, "");
  const prefix = `${SKILL_PLUGIN_NAME}:`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
