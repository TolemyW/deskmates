// Network profiles and their workspace selections (ADR-0027 amendment 1): the durable truth the
// Gateway publishes to each workspace's proxy and hook. Every change validates first, then writes
// its rows, the revision and the audit record in one transaction (decision 7).

import {
  DeskmatesError,
  type NetworkGrant,
  type NetworkProfile,
  type NetworkRule,
  type WorkspaceNetworkSelection,
  earlierExpiry,
  parseNetworkExpiry,
  parseNetworkProfileName,
  parseNetworkRules,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface ProfileRow {
  id: string;
  name: string;
  description: string;
  rules_json: string;
  expires_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

interface SelectionRow {
  profile_id: string;
  name: string;
  expires_at: string | null;
  selected_at: string;
  selected_by: string;
}

export interface NetworkProfileInput {
  name?: unknown;
  description?: unknown;
  rules?: unknown;
  expiresAt?: unknown;
}

/** A validated candidate; nothing is written until a candidate exists (decision 7). */
interface Candidate {
  name: string;
  description: string;
  rules: NetworkRule[];
  expiresAt: string | undefined;
}

function validate(input: NetworkProfileInput): Candidate {
  const description = input.description ?? "";
  if (typeof description !== "string" || description.length > 500)
    throw new DeskmatesError("validation", "description must be at most 500 characters");
  return {
    name: parseNetworkProfileName(input.name),
    description,
    rules: parseNetworkRules(input.rules),
    expiresAt: parseNetworkExpiry(input.expiresAt, "profile"),
  };
}

function toProfile(row: ProfileRow): NetworkProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: JSON.parse(row.rules_json) as NetworkRule[],
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export class NetworkProfileStore {
  constructor(private readonly db: GatewayDb) {}

  list(): NetworkProfile[] {
    return (
      this.db.prepare("SELECT * FROM network_profiles ORDER BY name").all() as ProfileRow[]
    ).map(toProfile);
  }

  get(id: string): NetworkProfile | undefined {
    const row = this.db.prepare("SELECT * FROM network_profiles WHERE id = ?").get(id) as
      | ProfileRow
      | undefined;
    return row === undefined ? undefined : toProfile(row);
  }

  mustGet(id: string): NetworkProfile {
    const profile = this.get(id);
    if (!profile) throw new DeskmatesError("not_found", "network profile not found", { id });
    return profile;
  }

  /** The workspaces that select a profile: the only ones a change to it is published to. */
  workspacesSelecting(profileId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT workspace_id FROM workspace_network_profiles WHERE profile_id = ? ORDER BY workspace_id",
        )
        .all(profileId) as { workspace_id: string }[]
    ).map((row) => row.workspace_id);
  }

  selections(workspaceId: string): WorkspaceNetworkSelection[] {
    const rows = this.db
      .prepare(
        `SELECT s.profile_id, p.name, s.expires_at, s.selected_at, s.selected_by
           FROM workspace_network_profiles s JOIN network_profiles p ON p.id = s.profile_id
          WHERE s.workspace_id = ? ORDER BY p.name`,
      )
      .all(workspaceId) as SelectionRow[];
    return rows.map((row) => ({
      profileId: row.profile_id,
      profileName: row.name,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      selectedAt: row.selected_at,
      selectedBy: row.selected_by,
    }));
  }

  /**
   * The unexpired grants a workspace's proxy and hook enforce (decisions 9 and 10): every rule of
   * every selected profile, with the earlier of the profile's and the selection's expiry.
   */
  grantsFor(workspaceId: string, now = Date.now()): NetworkGrant[] {
    const rows = this.db
      .prepare(
        `SELECT p.rules_json, p.expires_at AS profile_expires, s.expires_at AS selection_expires
           FROM workspace_network_profiles s JOIN network_profiles p ON p.id = s.profile_id
          WHERE s.workspace_id = ? ORDER BY p.name`,
      )
      .all(workspaceId) as {
      rules_json: string;
      profile_expires: string | null;
      selection_expires: string | null;
    }[];
    const grants: NetworkGrant[] = [];
    for (const row of rows) {
      const expiresAt = earlierExpiry(
        row.profile_expires ?? undefined,
        row.selection_expires ?? undefined,
      );
      if (expiresAt !== undefined && Date.parse(expiresAt) <= now) continue;
      for (const rule of JSON.parse(row.rules_json) as NetworkRule[])
        grants.push(expiresAt === undefined ? rule : { ...rule, expiresAt });
    }
    return grants;
  }

  create(input: NetworkProfileInput, by: string, tenantId: string): NetworkProfile {
    const candidate = validate(input);
    const id = newId("netp");
    const at = nowIso();
    this.db.transaction(() => {
      this.assertNameFree(candidate.name, id);
      this.db
        .prepare(
          `INSERT INTO network_profiles
             (id, name, description, rules_json, expires_at, revision, created_by, created_at, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          candidate.name,
          candidate.description,
          JSON.stringify(candidate.rules),
          candidate.expiresAt ?? null,
          by,
          at,
          by,
          at,
        );
      new AuditLog(this.db).record({
        action: "network_profile.create",
        actor: by,
        tenantId,
        targetKind: "network_profile",
        targetId: id,
        after: { ...candidate, revision: 1 },
      });
    })();
    return this.mustGet(id);
  }

  /**
   * Replace a profile whole. `expectedRevision`, when given, must match the stored revision:
   * a stale editor gets a conflict instead of overwriting a newer edit (decision 7).
   */
  replace(
    id: string,
    input: NetworkProfileInput,
    expectedRevision: number | undefined,
    by: string,
    tenantId: string,
  ): NetworkProfile {
    const candidate = validate(input);
    this.db.transaction(() => {
      const before = this.mustGet(id);
      if (expectedRevision !== undefined && expectedRevision !== before.revision)
        throw new DeskmatesError(
          "invalid_transition",
          "the network profile changed since it was read",
          {
            reason: "stale_revision",
            revision: before.revision,
          },
        );
      this.assertNameFree(candidate.name, id);
      this.db
        .prepare(
          `UPDATE network_profiles SET name = ?, description = ?, rules_json = ?, expires_at = ?,
             revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          candidate.name,
          candidate.description,
          JSON.stringify(candidate.rules),
          candidate.expiresAt ?? null,
          by,
          nowIso(),
          id,
        );
      new AuditLog(this.db).record({
        action: "network_profile.update",
        actor: by,
        tenantId,
        targetKind: "network_profile",
        targetId: id,
        before: {
          name: before.name,
          rules: before.rules,
          expiresAt: before.expiresAt,
          revision: before.revision,
        },
        after: { ...candidate, revision: before.revision + 1 },
      });
    })();
    return this.mustGet(id);
  }

  /** Deletes the profile and, by cascade, every selection of it. */
  delete(id: string, by: string, tenantId: string): NetworkProfile {
    const before = this.mustGet(id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM network_profiles WHERE id = ?").run(id);
      new AuditLog(this.db).record({
        action: "network_profile.delete",
        actor: by,
        tenantId,
        targetKind: "network_profile",
        targetId: id,
        before: { name: before.name, rules: before.rules, revision: before.revision },
      });
    })();
    return before;
  }

  /** Replaces a workspace's selections whole; every profile must exist (decision 12). */
  setSelections(
    workspaceId: string,
    selections: readonly { profileId: string; expiresAt?: string }[],
    by: string,
  ): WorkspaceNetworkSelection[] {
    const ids = selections.map((s) => s.profileId);
    if (new Set(ids).size !== ids.length)
      throw new DeskmatesError("validation", "a profile may be selected once per workspace");
    const before = this.selections(workspaceId);
    const at = nowIso();
    this.db.transaction(() => {
      for (const id of ids) this.mustGet(id);
      this.db
        .prepare("DELETE FROM workspace_network_profiles WHERE workspace_id = ?")
        .run(workspaceId);
      const insert = this.db.prepare(
        `INSERT INTO workspace_network_profiles (workspace_id, profile_id, expires_at, selected_by, selected_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const s of selections) {
        const kept = before.find((b) => b.profileId === s.profileId && b.expiresAt === s.expiresAt);
        insert.run(
          workspaceId,
          s.profileId,
          s.expiresAt ?? null,
          kept?.selectedBy ?? by,
          kept?.selectedAt ?? at,
        );
      }
      new AuditLog(this.db).record({
        action: "workspace.network_profiles_set",
        actor: by,
        workspaceId,
        targetKind: "workspace",
        targetId: workspaceId,
        before: {
          selections: before.map(({ profileId, expiresAt }) => ({ profileId, expiresAt })),
        },
        after: { selections },
      });
    })();
    return this.selections(workspaceId);
  }

  private assertNameFree(name: string, id: string): void {
    const clash = this.db
      .prepare("SELECT id FROM network_profiles WHERE name = ? AND id <> ?")
      .get(name, id);
    if (clash) throw new DeskmatesError("validation", "a network profile with that name exists");
  }
}
