import { SectionTabs } from "@deskmates/ui";
import { useState } from "react";
import { useT } from "../../i18n/i18n-provider.js";
import { useTuneView } from "../../lib/interface-view.js";
import { type DetailSectionProps, WORKSPACE_DETAIL_SECTIONS } from "./detail-sections.js";

export const WORKSPACE_SETTINGS_GROUPS = [
  "general",
  "collaboration",
  "environment",
  "lifecycle",
] as const;
export type WorkspaceSettingsGroup = (typeof WORKSPACE_SETTINGS_GROUPS)[number];

/** Mount on first visit and retain hidden editors, so changing category never discards input. */
export function WorkspaceSettings(props: DetailSectionProps) {
  const t = useT();
  const tune = useTuneView();
  const [selected, setSelected] = useState<WorkspaceSettingsGroup>("general");
  return (
    <div className="workspace-settings">
      <SectionTabs
        label={t("workspaceManage.settings.categories")}
        items={WORKSPACE_SETTINGS_GROUPS.map((group) => ({
          key: group,
          label: t(`workspaceManage.settings.${group}`),
        }))}
        value={selected}
        onChange={setSelected}
        keepMounted
        renderPanel={(group) => (
          <>
            <p className="workspace-settings-intro">{t(`workspaceManage.settings.${group}Hint`)}</p>
            {WORKSPACE_DETAIL_SECTIONS.filter(
              (section) => section.group === group && (section.audience !== "tune" || tune),
            ).map(({ key, Section }) => (
              <Section key={key} {...props} />
            ))}
          </>
        )}
      />
    </div>
  );
}
