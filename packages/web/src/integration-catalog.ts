// Presentation metadata for issue #42. Capability still comes only from the Gateway's live
// catalog: these records never create a provider or a dead button. A known service gets a local
// release asset when one is licensed; every other service gets the letter fallback.

import type { MessageKey } from "./i18n/catalogs.js";

export type IntegrationCategory =
  | "code"
  | "documents"
  | "communication"
  | "projects"
  | "data"
  | "other";

export interface IntegrationPresentation {
  category: IntegrationCategory;
  logo?: string;
  summary: MessageKey;
}

export const FEATURED_SERVICES = [
  "github",
  "gitlab",
  "googledrive",
  "gmail",
  "googlecalendar",
  "slack",
  "notion",
  "jira",
  "confluence",
  "linear",
] as const;

const PRESENTATION: Readonly<Record<string, IntegrationPresentation>> = {
  github: { category: "code", logo: "github.svg", summary: "integrations.summary.code" },
  gitlab: { category: "code", logo: "gitlab.svg", summary: "integrations.summary.code" },
  googledrive: {
    category: "documents",
    logo: "googledrive.svg",
    summary: "integrations.summary.documents",
  },
  gmail: {
    category: "communication",
    logo: "gmail.svg",
    summary: "integrations.summary.email",
  },
  googlecalendar: {
    category: "projects",
    logo: "googlecalendar.svg",
    summary: "integrations.summary.calendar",
  },
  slack: { category: "communication", summary: "integrations.summary.communication" },
  notion: {
    category: "documents",
    logo: "notion.svg",
    summary: "integrations.summary.documents",
  },
  jira: { category: "projects", logo: "jira.svg", summary: "integrations.summary.projects" },
  confluence: {
    category: "documents",
    logo: "confluence.svg",
    summary: "integrations.summary.documents",
  },
  linear: {
    category: "projects",
    logo: "linear.svg",
    summary: "integrations.summary.projects",
  },
  hubspot: { category: "data", logo: "hubspot.svg", summary: "integrations.summary.data" },
  airtable: { category: "data", logo: "airtable.svg", summary: "integrations.summary.data" },
  stripe: { category: "data", logo: "stripe.svg", summary: "integrations.summary.data" },
};

export function integrationPresentation(service: string): IntegrationPresentation {
  return (
    PRESENTATION[service.toLocaleLowerCase()] ?? {
      category: "other",
      summary: "integrations.summary.other",
    }
  );
}

export function integrationLogoUrl(service: string): string | undefined {
  const logo = integrationPresentation(service).logo;
  return logo ? `/integration-logos/${logo}` : undefined;
}
