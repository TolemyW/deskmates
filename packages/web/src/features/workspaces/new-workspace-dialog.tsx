// The one place a workspace is created. The dialog says what the operator is making: a second
// team of bots on a second computer, with its own logins, files, chats and contacts.

import { EGRESS_OPEN_INTERNET, type Workspace } from "@deskmates/contracts";
import { type FormEvent, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { errorMessage, splitList } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { EgressModePicker } from "./egress-mode-picker.js";
import {
  WorkspaceNameField,
  submittedWorkspaceName,
  workspaceNameAcceptable,
} from "./workspace-name-field.js";

/** An example workspace name: a slug, the same in every language. */
const NAME_EXAMPLE = "web-research";

export function NewWorkspaceDialog({
  api,
  open,
  onClose,
  onCreated,
}: {
  api: ApiClient;
  open: boolean;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [locked, setLocked] = useState(false);
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const created = await api.createWorkspace({
        name: submittedWorkspaceName(name),
        egressAllowlist: locked ? splitList(domains) : [EGRESS_OPEN_INTERNET],
      });
      setName("");
      setDomains("");
      onCreated(created);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogContent className="max-w-md" closeLabel={t("newWorkspaceDialog.closeLabel")}>
        <DialogTitle className="pr-8 text-lg font-semibold">
          {t("newWorkspaceDialog.title")}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t("newWorkspaceDialog.description")}
        </DialogDescription>
        <form className="stack" onSubmit={submit} aria-label={t("newWorkspaceDialog.formLabel")}>
          <WorkspaceNameField
            value={name}
            onChange={setName}
            label={t("newWorkspaceDialog.name")}
            placeholder={NAME_EXAMPLE}
          />
          <EgressModePicker
            locked={locked}
            domains={domains}
            onLocked={setLocked}
            onDomains={setDomains}
          />
          {error ? <p className="error small">{error}</p> : null}
          <Button type="submit" variant="default" disabled={busy || !workspaceNameAcceptable(name)}>
            {t("newWorkspaceDialog.create")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
