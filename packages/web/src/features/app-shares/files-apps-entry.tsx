// The Files page's entry to published apps (ADR-0035, owner-decided 2026-10-14): a button in the
// page heading that opens the workspace's apps dialog, where any Member lists, opens,
// shares a running port and stops sharing.

import { AppWindow } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { AppSharesApi } from "./api.js";
import { AppSharesPanel } from "./app-shares-panel.js";

export function FilesAppsEntry({ api, workspaceId }: { api: AppSharesApi; workspaceId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="files-apps-entry">
      <Button
        data-row-control
        type="button"
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <AppWindow size={16} aria-hidden="true" /> {t("appShares.title")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent scroll>
          <DialogTitle>{t("appShares.title")}</DialogTitle>
          <p className="muted">{t("appShares.intro")}</p>
          <AppSharesPanel api={api} workspaceId={workspaceId} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
