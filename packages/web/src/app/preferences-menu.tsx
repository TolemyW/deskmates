import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { type PreferenceControls, PreferencesSection } from "../features/account/preferences.js";
import { useT } from "../i18n/i18n-provider.js";

/** One entry for browser/account preferences; opening never changes view or location. */
export function PreferencesMenu(props: PreferenceControls) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="sidebar-view-switch"
          data-tune={props.view === "tune"}
          aria-label={t("account.preferences.title")}
          title={t("account.preferences.title")}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span>{t("account.preferences.title")}</span>
          <span className="sidebar-mode-state" aria-hidden="true">
            {t(props.view === "tune" ? "app.preferences.tune" : "app.preferences.use")}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent
        className="preferences-dialog"
        closeLabel={t("account.preferences.close")}
        aria-describedby="preferences-description"
        aria-labelledby="account-preferences-title"
        scroll
      >
        <DialogTitle id="account-preferences-title">{t("account.preferences.title")}</DialogTitle>
        <DialogDescription id="preferences-description">
          {t("account.preferences.intro")}
        </DialogDescription>
        <PreferencesSection {...props} />
      </DialogContent>
    </Dialog>
  );
}
