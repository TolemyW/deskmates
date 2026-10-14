// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { actorLabel, approvalEchoLabel } from "./actor-label.js";
import { SessionRolesProvider, useActorLabel } from "./session-roles.js";

const self = { actorId: "user:usr_1", displayName: "Alex" };
afterEach(cleanup);

describe("authorized session actor labels (#75 partial)", () => {
  it("resolves only exact human/session keys, never another actor with the same display name", () => {
    expect(actorLabel("user:usr_1", self)).toBe("Alex");
    expect(actorLabel("human:user:usr_1", self)).toBe("Alex");
    for (const actor of [
      "user:usr_2",
      "human:user:usr_2",
      "user:usr_10",
      "bot:usr_1",
      "reviewer:usr_1",
      "system",
      "human:web",
      "human:Alex",
    ]) {
      expect(actorLabel(actor, self)).toBe(actor);
    }
  });

  it("falls back for absent/deleted/inaccessible identities and empty names", () => {
    expect(actorLabel("user:usr_1")).toBe("user:usr_1");
    expect(actorLabel("user:usr_1", { ...self, displayName: " " })).toBe("user:usr_1");
    expect(actorLabel("bot:bot_1", { actorId: "bot:bot_1", displayName: "Alex" })).toBe(
      "bot:bot_1",
    );
  });

  it("updates a renamed user and clears the previous account label when the session changes", () => {
    const Label = () => <p>{useActorLabel()("human:user:usr_1")}</p>;
    const view = (actorId: string, displayName?: string) => (
      <SessionRolesProvider
        roles={{ tenantRole: "member", platformMaintainer: false }}
        actorId={actorId}
        {...(displayName ? { displayName } : {})}
      >
        <Label />
      </SessionRolesProvider>
    );
    const { rerender } = render(view(self.actorId, "Alex"));
    expect(screen.getByText("Alex")).toBeTruthy();
    rerender(view(self.actorId, "Renamed person"));
    expect(screen.getByText("Renamed person")).toBeTruthy();
    rerender(view("user:usr_2", "Alex"));
    expect(screen.getByText("human:user:usr_1")).toBeTruthy();
    rerender(view(self.actorId));
    expect(screen.getByText("human:user:usr_1")).toBeTruthy();
  });

  it("formats the Gateway decision prefix but leaves quoted IDs in reasons untouched", () => {
    const resolve = (actor: string) => actorLabel(actor, self);
    expect(approvalEchoLabel("Denied by human:user:usr_1: ask human:user:usr_2", resolve)).toBe(
      "Denied by Alex: ask human:user:usr_2",
    );
    expect(approvalEchoLabel("Approved by human:user:usr_1", resolve)).toBe("Approved by Alex");
    expect(approvalEchoLabel("Quoted: Approved by human:user:usr_1", resolve)).toBe(
      "Quoted: Approved by human:user:usr_1",
    );
  });
});
