// How an acceptance fixture gives a bot its SOUL.
//
// The Gateway owns the SOUL (canonical bot files, migration 0019): a bot created through the API
// starts with an empty canonical SOUL, and every run restores the canonical copy over the
// SOUL.md in the container. A fixture that only writes the file therefore runs its bot with no
// instructions at all. That was found on the first paired foundation campaign of 2026-09-30,
// where every run in both arms carried the version of the empty SOUL and the chief reached for
// tools its SOUL forbids. Fixtures set the SOUL through the route an operator uses.

export type FixtureApi = <T>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: T }>;

/** Read the bot's current canonical SOUL version, then replace the SOUL against it. */
export async function setCanonicalSoul(
  api: FixtureApi,
  botId: string,
  soul: string,
  what: string = botId,
): Promise<void> {
  const route = `/api/bots/${botId}/soul`;
  const current = await api<{ soul: { version: string } }>("GET", route);
  if (current.status !== 200) {
    throw new Error(`read SOUL of ${what}: ${current.status} ${JSON.stringify(current.json)}`);
  }
  const saved = await api<{ soul: { version: string } }>("PATCH", route, {
    body: soul,
    expectedVersion: current.json.soul.version,
  });
  if (saved.status !== 200) {
    throw new Error(`set SOUL of ${what}: ${saved.status} ${JSON.stringify(saved.json)}`);
  }
}
