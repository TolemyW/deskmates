/** Presentation only: resolve exact identities from already-authorized metadata. Never infer
 * identity from a display name, bot name, reviewer label or arbitrary text. */
export interface ActorIdentity {
  actorId: string;
  displayName: string;
}

export function actorLabel(
  actor: string,
  identity?: ActorIdentity,
  directory?: ReadonlyMap<string, string>,
): string {
  const key = actor.startsWith("human:user:") ? actor.slice(6) : actor;
  if (!/^user:[a-zA-Z0-9_-]+$/.test(key)) return actor;
  if (key === identity?.actorId && identity.displayName.trim()) return identity.displayName;
  return directory?.get(key) || actor;
}

/** Gateway-authored decision prefix only; never rewrite a quoted actor in the decision reason. */
export function approvalEchoLabel(body: string, resolve: (actor: string) => string): string {
  return body.replace(
    /^(Approved|Denied) by (human:user:[a-zA-Z0-9_-]+)(?=:|$)/,
    (_match, verb, actor) => `${verb} by ${resolve(actor)}`,
  );
}
