import {
  ArrowDownToLine,
  ArrowUp,
  BadgeCheck,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Copy,
  FileText,
  Info,
  ListTodo,
  Menu,
  MessageCircle,
  Moon,
  Pencil,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

const icons = {
  download: ArrowDownToLine,
  send: ArrowUp,
  verified: BadgeCheck,
  book: BookOpen,
  check: Check,
  chevron: ChevronDown,
  alert: CircleAlert,
  clock: Clock3,
  copy: Copy,
  file: FileText,
  info: Info,
  tasks: ListTodo,
  menu: Menu,
  chat: MessageCircle,
  moon: Moon,
  edit: Pencil,
  plus: Plus,
  search: Search,
  settings: Settings2,
  shield: ShieldCheck,
  sun: Sun,
  user: UserRound,
  close: X,
  trash: Trash2,
};
export type IconName = keyof typeof icons;

/** Decorative icons inherit color; the containing control supplies its accessible name. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const Glyph = icons[name];
  return <Glyph size={size} strokeWidth={1.8} aria-hidden="true" className="gb-icon" />;
}
