import type { WorkspaceId } from "@deskmates/contracts";
import { useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../../components/ui/dialog.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useCan } from "../../state/session-roles.js";
import { TemplatesSection } from "./templates-section.js";

export function TaskTemplatesDialog({
  api,
  workspaceId,
  onChanged,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  /** Told after a template is saved or archived, so a template picker can reload. */
  onChanged?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const canRead = useCan("taskKinds.read", workspaceId).allowed;
  if (!canRead) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="secondary">
          {t("taskKinds.templates.heading")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="task-templates-dialog"
        aria-describedby={undefined}
        closeLabel={t("taskKinds.templates.close")}
        scroll
      >
        <DialogTitle>{t("taskKinds.templates.heading")}</DialogTitle>
        {open ? (
          <TemplatesSection
            key={workspaceId}
            api={api}
            workspaceId={workspaceId}
            onChanged={onChanged}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
