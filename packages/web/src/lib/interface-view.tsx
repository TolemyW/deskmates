// The interface view: "use" shows what a person needs to work with the bots; "tune" adds every
// knob, diagnostic and operations screen the operator uses to improve them (see
// docs/use-and-tune-views.md). Like the colour theme it is a per-browser convenience kept in
// localStorage; nothing about it reaches the Gateway, and it decides presentation only: a hidden
// screen stays reachable by its address, and the Gateway still refuses what a role may not do.

import { type ReactNode, createContext, useCallback, useContext, useState } from "react";

export type InterfaceView = "use" | "tune";

const KEY = "deskmates.view";

export function loadInterfaceView(): InterfaceView {
  try {
    return window.localStorage.getItem(KEY) === "tune" ? "tune" : "use";
  } catch {
    return "use";
  }
}

/** The stored view and its setter; the shell owns one and provides it to every screen. */
export function useInterfaceViewPreference(): {
  view: InterfaceView;
  setView: (next: InterfaceView) => void;
} {
  const [view, setViewState] = useState<InterfaceView>(loadInterfaceView);
  const setView = useCallback((next: InterfaceView) => {
    setViewState(next);
    try {
      if (next === "use") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch {
      // Storage disabled: the choice lasts for this page load.
    }
  }, []);
  return { view, setView };
}

/**
 * Outside the shell (a screen rendered on its own, as in its tests) every part shows: the
 * default is the full "tune" interface, and the shell provides the person's stored choice.
 */
const InterfaceViewContext = createContext<InterfaceView>("tune");

export function InterfaceViewProvider({
  view,
  children,
}: {
  view: InterfaceView;
  children: ReactNode;
}) {
  return <InterfaceViewContext.Provider value={view}>{children}</InterfaceViewContext.Provider>;
}

/** The view the shell shows. */
export function useInterfaceView(): InterfaceView {
  return useContext(InterfaceViewContext);
}

/** Whether the tune-only parts show. */
export function useTuneView(): boolean {
  return useInterfaceView() === "tune";
}

/** Renders its children only in the tune view. */
export function TuneOnly({ children }: { children: ReactNode }) {
  return useTuneView() ? <>{children}</> : null;
}
