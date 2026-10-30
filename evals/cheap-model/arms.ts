// The arms of the cheap-model comparison (ADR-0023 decision 2, the switch ADR-0039 prepared):
// one build, two configurations that differ only in the model `CHEAP_MODEL` names. The model ids
// come from the campaign environment, never from this file (AGENTS.md: the model is
// configuration). Configuration only: nothing here has been run, and no result exists.

export type CheapArm = "incumbent" | "candidate";

export interface CheapArmConfig {
  arm: CheapArm;
  /** The campaign variable that holds this arm's model id. */
  modelVar: "EVAL_CHEAP_INCUMBENT" | "EVAL_CHEAP_CANDIDATE";
}

export const CHEAP_ARMS: readonly CheapArmConfig[] = [
  { arm: "incumbent", modelVar: "EVAL_CHEAP_INCUMBENT" },
  { arm: "candidate", modelVar: "EVAL_CHEAP_CANDIDATE" },
];

export function cheapArm(name: string | undefined): CheapArmConfig {
  const found = CHEAP_ARMS.find((a) => a.arm === name?.trim());
  if (!found)
    throw new Error(
      `EVAL_ARM must be ${CHEAP_ARMS.map((a) => a.arm).join(" or ")}, got ${name ?? "nothing"}`,
    );
  return found;
}

/**
 * `CHEAP_MODEL` for one arm's Gateway. Both ids must be set and must differ, so a campaign cannot
 * compare a model with itself and call it a switch.
 */
export function cheapArmModel(
  arm: CheapArm,
  env: Readonly<Record<string, string | undefined>>,
): { CHEAP_MODEL: string } {
  const incumbent = (env.EVAL_CHEAP_INCUMBENT ?? "").trim();
  const candidate = (env.EVAL_CHEAP_CANDIDATE ?? "").trim();
  if (incumbent === "" || candidate === "")
    throw new Error("EVAL_CHEAP_INCUMBENT and EVAL_CHEAP_CANDIDATE must both be set");
  if (incumbent === candidate)
    throw new Error("the incumbent and the candidate are the same model");
  return { CHEAP_MODEL: arm === "incumbent" ? incumbent : candidate };
}

/**
 * Arm order per repetition block: AB, BA, AB, ... Job runs are short, so within a block every
 * task runs on both arms' stacks back to back before the next task starts.
 */
export function cheapArmOrder(repetitions: number): CheapArm[][] {
  if (!Number.isInteger(repetitions) || repetitions < 1)
    throw new Error("repetitions must be a positive integer");
  return Array.from({ length: repetitions }, (_, rep) =>
    rep % 2 === 0 ? ["incumbent", "candidate"] : ["candidate", "incumbent"],
  );
}
