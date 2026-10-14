import * as Primitive from "@radix-ui/react-dialog";
import {
  type ComponentProps,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePanelWidth } from "../../state/panel-width.js";
import { DialogContent } from "./dialog.js";

const Layout = createContext<{
  desktop: boolean;
  host: HTMLDivElement | null;
  active: string | undefined;
  register: (id: string) => () => void;
} | null>(null);
const Pane = createContext<{ docked: boolean; id: string; open: boolean }>({
  docked: false,
  id: "",
  open: false,
});

/** Only inspectable details opt in. Confirmation dialogs retain their modal contract. */
export function DetailPaneLayout({ children }: { children: ReactNode }) {
  const [desktop, setDesktop] = useState(() => window.innerWidth >= 1280);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [panes, setPanes] = useState<string[]>([]);
  const register = useCallback((id: string) => {
    setPanes((current) => [...current.filter((item) => item !== id), id]);
    return () => setPanes((current) => current.filter((item) => item !== id));
  }, []);
  useEffect(() => {
    const resize = () => setDesktop(window.innerWidth >= 1280);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const value = useMemo(
    () => ({ desktop, host, active: panes.at(-1), register }),
    [desktop, host, panes, register],
  );
  return (
    <Layout.Provider value={value}>
      <div className="detail-layout" data-docked={desktop && panes.length > 0}>
        {children}
        <div className="detail-pane-host" ref={setHost} />
      </div>
    </Layout.Provider>
  );
}

export function DetailPane({
  open = false,
  children,
  ...props
}: ComponentProps<typeof Primitive.Root>) {
  const layout = useContext(Layout);
  const id = useId();
  const register = layout?.register;
  useEffect(() => (open && register ? register(id) : undefined), [open, register, id]);
  const docked = !!layout?.desktop;
  return (
    <Pane.Provider value={{ docked, id, open }}>
      <Primitive.Root {...props} open={open} modal={!docked}>
        {children}
      </Primitive.Root>
    </Pane.Provider>
  );
}

export function DetailPaneContent(props: ComponentProps<typeof DialogContent>) {
  const layout = useContext(Layout);
  const { docked, id, open } = useContext(Pane);
  const isOpen = useRef(open);
  isOpen.current = open;
  const contentProps = {
    ...props,
    onCloseAutoFocus: (event: Event) => {
      // Reparenting on a responsive breakpoint is not a user close.
      if (isOpen.current) event.preventDefault();
      else props.onCloseAutoFocus?.(event);
    },
  };
  const [body] = useState(() => {
    const node = document.createElement("div");
    node.className = "detail-pane-body";
    return node;
  });
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) node.appendChild(body);
    },
    [body],
  );
  const width = usePanelWidth("detail", 440, 320, (vw) => Math.min(640, vw - 940));
  if (!layout) return <DialogContent {...contentProps} />;
  return (
    <>
      <DialogContent
        {...contentProps}
        {...(docked && layout.host
          ? { dock: { host: layout.host, hidden: layout.active !== id, width } }
          : {})}
      >
        <div className="detail-pane-mount" ref={attach} />
      </DialogContent>
      {open ? createPortal(props.children, body) : null}
    </>
  );
}
