// The `Skill` tool on the OpenAI runtime (ADR-0015 on ADR-0044): loads one enabled skill's
// SKILL.md into context, from the plugin directory the run materialised, by name. The Claude SDK
// has this built in; here it is a function tool with the same name and input, so the hook's
// `skill_used` measurement (ADR-0015 decision 6) and the L0 tier row apply unchanged. Only a
// skill of the run's set can be read; a name outside it is an error, never a file read.

import { isSkillName } from "@deskmates/contracts";
import { skillOfToolInput } from "../../skill-plugin.js";
import type { OpenAiQueryParams, ToolSpec } from "./types.js";

/** Longest SKILL.md handed to the model, in characters. */
export const SKILL_MAX_CHARS = 40_000;

export function skillTool(skills: NonNullable<OpenAiQueryParams["skills"]>): ToolSpec {
  return {
    name: "Skill",
    description: `Load the instructions of one of your enabled skills into context. Enabled: ${skills.names.join(", ")}.`,
    parameters: {
      type: "object",
      properties: { skill: { type: "string", description: "The skill's name." } },
      required: ["skill"],
      additionalProperties: false,
    },
    async run(input) {
      const name = skillOfToolInput(input);
      if (name === undefined || !isSkillName(name) || !skills.names.includes(name))
        return { text: `No enabled skill named ${String(input.skill ?? "")}`, isError: true };
      try {
        const text = await skills.readFile(`${skills.dir}/skills/${name}/SKILL.md`);
        return {
          text: text.length <= SKILL_MAX_CHARS ? text : `${text.slice(0, SKILL_MAX_CHARS)}…`,
        };
      } catch (err) {
        return { text: `Skill ${name} could not be read: ${String(err)}`, isError: true };
      }
    },
  };
}
