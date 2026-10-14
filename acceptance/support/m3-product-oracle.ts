import { OPS_ACCOUNT, PASSWORD } from "@deskmates/golden-site";

/** Host-only positive control on the exact disposable app; never sent to the bot. */
export async function changeProductOpenCount(
  origin: string,
): Promise<{ before: number; after: number; ticketId: string }> {
  const stateResponse = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(5000) });
  if (stateResponse.status !== 200) throw Error("product control state unavailable");
  const state = (await stateResponse.json()) as {
    tickets: Record<string, { id: string; status: string }>;
  };
  const open = Object.values(state.tickets).filter((ticket) => ticket.status === "open");
  const ticket = open[0];
  if (!ticket) throw Error("product control needs an open ticket");
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ email: OPS_ACCOUNT, password: PASSWORD }),
    signal: AbortSignal.timeout(5000),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (login.status !== 200 || !cookie) throw Error("product control login failed");
  const close = await fetch(`${origin}/tickets/${encodeURIComponent(ticket.id)}/close`, {
    method: "POST",
    headers: { accept: "application/json", cookie },
    signal: AbortSignal.timeout(5000),
  });
  if (close.status !== 200) throw Error("product control ticket close failed");
  const changed = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(5000) });
  if (changed.status !== 200) throw Error("product control changed state unavailable");
  const changedState = (await changed.json()) as typeof state;
  const after = Object.values(changedState.tickets).filter((item) => item.status === "open").length;
  if (after !== open.length - 1) throw Error("product control count did not change by one");
  const dashboard = await fetch(`${origin}/dashboard`, {
    headers: { cookie },
    signal: AbortSignal.timeout(5000),
  });
  if (dashboard.status !== 200) throw Error("product control dashboard unavailable");
  const displayed = /id="open-ticket-count">(\d+)/.exec(await dashboard.text())?.[1];
  if (displayed === undefined || Number(displayed) !== after)
    throw Error("product control dashboard disagrees with changed state");
  return { before: open.length, after, ticketId: ticket.id };
}
