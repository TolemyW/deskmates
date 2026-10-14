// Test-only: the expectations a feature's own `feature.test.tsx` states (issue #53): its
// navigation entry and the screen it renders for each address. Never imported by app code.

import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { ENGLISH, type MessageKey } from "../../i18n/catalogs.js";
import { parseRoute } from "../../router.js";
import type { Feature, NavGroup, ShellContext } from "../feature.js";
import { FEATURES, featureFor } from "../features.js";
import { shownRoute } from "../route-registry.js";

/** A stand-in context: `render` only builds elements, it calls nothing. */
export const STUB_CONTEXT = {
  api: { name: "api" },
  members: { name: "members" },
  account: { name: "account" },
  session: {
    user: { id: "usr_1" },
    tenant: { id: "tnt_1", name: "Tenant", role: "owner" },
    tenants: [{ id: "tnt_1", ssoProviders: [{ id: "sso_1" }] }],
  },
  manager: true,
  locale: "en",
  changeLocale: () => undefined,
  theme: { preference: "system", setPreference: () => undefined },
  onProfile: () => undefined,
  onSessionRotated: () => undefined,
  onSignOut: () => undefined,
  checkConnection: () => undefined,
} as unknown as ShellContext;

/** The element the shell puts in the work area (or the drawer) for an address and role. */
export function renderedFor(hash: string, manager = true): ReactElement<Record<string, unknown>> {
  const shown = shownRoute(parseRoute(hash), { manager });
  const element = featureFor(shown)?.render(shown, { ...STUB_CONTEXT, manager });
  expect(element, hash).toBeTruthy();
  return element as ReactElement<Record<string, unknown>>;
}

/** The folder names of the features whose navigation entry is current at an address. */
export function currentEntries(hash: string): string[] {
  const route = parseRoute(hash);
  return [...FEATURES].filter(([, f]) => f.nav?.active(route)).map(([folder]) => folder);
}

export interface NavExpectations {
  folder: string;
  feature: Feature<never>;
  group: NavGroup;
  order: number;
  /** The lucide component drawn at size 18. */
  icon: unknown;
  label: MessageKey;
  /** The label in English, as the link shows it. */
  english: string;
  href: string;
  /** Addresses at which this entry, and no other, is the current page. */
  currentAt: string[];
  /** Addresses of this feature at which no entry is current. */
  noneCurrentAt?: string[];
  /** Who sees the link. */
  visibleTo: { manager: boolean; member: boolean };
}

export function describeNavEntry(expected: NavExpectations): void {
  describe(`${expected.folder} navigation entry`, () => {
    const feature = expected.feature as unknown as Feature;
    const nav = feature.nav;

    it("is registered under its folder", () => {
      expect(FEATURES.get(expected.folder)).toBe(feature);
    });

    it("sits in its group and place, with its icon, label and address", () => {
      expect(nav?.group).toBe(expected.group);
      expect(nav?.order).toBe(expected.order);
      const icon = nav?.icon as ReactElement<{ size?: number }>;
      expect(icon.type).toBe(expected.icon);
      expect(icon.props.size).toBe(18);
      expect(nav?.label).toBe(expected.label);
      expect(ENGLISH[expected.label]).toBe(expected.english);
      expect(nav?.href()).toBe(expected.href);
    });

    it("is the only current entry where it should be", () => {
      for (const hash of expected.currentAt)
        expect(currentEntries(hash), hash).toEqual([expected.folder]);
      for (const hash of expected.noneCurrentAt ?? [])
        expect(currentEntries(hash), hash).toEqual([]);
    });

    it("shows to the roles that may use it", () => {
      expect(nav?.visible?.({ manager: true }) ?? true).toBe(expected.visibleTo.manager);
      expect(nav?.visible?.({ manager: false }) ?? true).toBe(expected.visibleTo.member);
    });
  });
}

/** An address, the screen component, and props the element must carry besides `api`. */
export type RenderRow = [hash: string, type: unknown, props: Record<string, unknown>];

export function describeRender(folder: string, rows: RenderRow[], manager = true): void {
  it(`${folder} renders its screen for each address${manager ? "" : " to a Member"}`, () => {
    for (const [hash, type, props] of rows) {
      const element = renderedFor(hash, manager);
      expect(element.type, hash).toBe(type);
      for (const [key, value] of Object.entries(props))
        expect(element.props[key], `${hash} ${key}`).toEqual(value);
    }
  });
}
