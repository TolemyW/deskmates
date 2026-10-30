// The shape of an operator route policy (ADR-0022 P2) and the shorthands the domain files use.
// The guard that enforces policies and the one aggregation point are in `../route-policy.ts`.

import type { TenantRole } from "@deskmates/contracts";
import type { OwnedKind } from "../../tenancy/ownership.js";

type IdRef = OwnedKind | `${OwnedKind}[]`;

export type RoutePolicy =
  | {
      /** Tenant data. The caller acts in their selected tenant with at least this role. */
      access: "tenant";
      role: TenantRole;
      params?: Record<string, OwnedKind>;
      query?: Record<string, OwnedKind>;
      body?: Record<string, IdRef>;
      /** Returns a collection the handler filters by the caller's tenant in SQL. */
      scopedList?: true;
      /** Handler-level check this table cannot express; named so a reviewer can find it. */
      handlerCheck?: string;
    }
  | {
      /** Installation-wide maintenance: the operator credential or a platform maintainer. */
      access: "platform";
    }
  | {
      /**
       * The root's alone (ADR-0022 amendment 6 W2): the operator credential or the protected
       * account, in its tenant. Service principals and tenant SSO (ADR-0031 Q2).
       */
      access: "root";
      handlerCheck?: string;
    }
  | {
      /**
       * The root's own browser session: the protected account signed in, never the operator
       * credential, a service principal or a run token (ADR-0046 amendment 1 decision 13).
       */
      access: "root_session";
    }
  | {
      /** Any signed-in principal; the response holds no tenant data (catalogs, model names). */
      access: "authenticated";
    };

/** One domain's policies, keyed `METHOD /path` exactly as Fastify registers the route. */
export type PolicyTable = Readonly<Record<string, RoutePolicy>>;

type TenantExtra = Omit<Extract<RoutePolicy, { access: "tenant" }>, "access" | "role">;

/** Every current member of the workspace, Guests included (ADR-0022 amendment 6 W6). */
export const guest = (extra: TenantExtra = {}) =>
  ({ access: "tenant", role: "guest", ...extra }) as const;
export const member = (extra: TenantExtra = {}) =>
  ({ access: "tenant", role: "member", ...extra }) as const;
export const admin = (extra: TenantExtra = {}) =>
  ({ access: "tenant", role: "admin", ...extra }) as const;
export const platform = { access: "platform" } as const;
export const root = (handlerCheck?: string) =>
  ({ access: "root", ...(handlerCheck ? { handlerCheck } : {}) }) as const;
export const authenticated = { access: "authenticated" } as const;
export const rootSession = { access: "root_session" } as const;
