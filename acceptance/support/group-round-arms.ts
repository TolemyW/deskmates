// The three arms of the group-round evaluation (ADR-0005 amendment 6, decision 52; issue #12).
// One build, three configurations: `parallel` and `in-turn` are `owner-v1` with the `@everyone`
// case sent parallel or one by one (amendment 4, decision 29); `round-v1` is the triaged round.
// Configuration only: nothing here has been run against a model, and no result exists.

import type { GroupRouting, RequestedRoundMode } from "@deskmates/contracts";

export type GroupRoundArm = "parallel" | "in-turn" | "round-v1";

export interface GroupRoundArmConfig {
  arm: GroupRoundArm;
  /** `DESKMATES_GROUP_ROUTING` for the stack under test. */
  groupRouting: GroupRouting;
  /** What the `@everyone` case asks for; ignored by the Gateway under `round-v1`. */
  everyoneRoundMode: RequestedRoundMode;
}

export const GROUP_ROUND_ARMS: readonly GroupRoundArmConfig[] = [
  { arm: "parallel", groupRouting: "owner-v1", everyoneRoundMode: "parallel" },
  { arm: "in-turn", groupRouting: "owner-v1", everyoneRoundMode: "sequential" },
  { arm: "round-v1", groupRouting: "round-v1", everyoneRoundMode: "parallel" },
];

/** The environment variable that names the arm of one campaign stack. */
export const GROUP_ROUND_ARM_ENV = "M2_GROUP_ROUND_ARM";

/**
 * The arm named by `M2_GROUP_ROUND_ARM`. Unset means the arm that matches the stack's routing, so
 * the suite keeps working unchanged outside a campaign; an unknown name is an error.
 */
export function groupRoundArm(
  value: string | undefined,
  routing: GroupRouting,
): GroupRoundArmConfig {
  const name = value?.trim();
  if (!name) {
    const arm = routing === "round-v1" ? "round-v1" : "parallel";
    return GROUP_ROUND_ARMS.find((a) => a.arm === arm) as GroupRoundArmConfig;
  }
  const found = GROUP_ROUND_ARMS.find((a) => a.arm === name);
  if (!found)
    throw new Error(
      `${GROUP_ROUND_ARM_ENV} must be ${GROUP_ROUND_ARMS.map((a) => a.arm).join(", ")}, got ${name}`,
    );
  if (found.groupRouting !== routing)
    throw new Error(
      `${GROUP_ROUND_ARM_ENV}=${found.arm} needs DESKMATES_GROUP_ROUTING=${found.groupRouting}, the stack has ${routing}`,
    );
  return found;
}

/** The environment one arm's campaign stack is started with. */
export function armEnvironment(arm: GroupRoundArm): Record<string, string> {
  const config = GROUP_ROUND_ARMS.find((a) => a.arm === arm);
  if (!config) throw new Error(`unknown arm ${arm}`);
  return { DESKMATES_GROUP_ROUTING: config.groupRouting, [GROUP_ROUND_ARM_ENV]: config.arm };
}

/**
 * The order of the arms in each repetition: a rotation (a Latin square over three arms), so no arm
 * always runs first on a warm or a cold host. One build and one image for all of them.
 */
export function armSchedule(repetitions: number): GroupRoundArm[][] {
  if (!Number.isInteger(repetitions) || repetitions < 1)
    throw new Error("repetitions must be a positive integer");
  const arms = GROUP_ROUND_ARMS.map((a) => a.arm);
  return Array.from({ length: repetitions }, (_, rep) =>
    arms.map((_, i) => arms[(i + rep) % arms.length] as GroupRoundArm),
  );
}
