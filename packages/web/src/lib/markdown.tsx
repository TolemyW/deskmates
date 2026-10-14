import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@deskmates/ui";
// A small Markdown renderer for chat bodies. It produces React elements only, never HTML, so
// nothing a bot or a page writes can become markup: raw HTML tags stay literal text, links are
// limited to http(s) and open in a new tab with no referrer, and images are not rendered.
//
// Supported: paragraphs, headings (#..###), bullet and numbered lists (one level of nesting by
// indentation), fenced code, blockquotes, horizontal rules, simple pipe tables, and inline
// `code`, **bold**, *italic*, ~~strike~~, [text](url), bare URLs and @mentions. Plain text runs
// are handed to `renderText` so callers can turn workspace paths into download links. The
// bundled manual passes `MarkdownOptions` to route links and images through its manifest.

import type { ReactNode } from "react";
import { currentI18n } from "../i18n/intl.js";

export type TextRenderer = (text: string, key: string) => ReactNode;

/**
 * Hooks a caller may supply instead of the chat defaults (the bundled manual, issue #28). Each one
 * still receives Markdown text only and returns React elements; nothing becomes markup.
 */
export interface MarkdownOptions {
  /** Render `[text](href)`; the default links http(s) only, in a new tab. */
  renderLink?: (href: string, children: ReactNode, key: string) => ReactNode;
  /** Render `![alt](src)`. Without it image syntax is not recognised, as in chat. */
  renderImage?: (src: string, alt: string, key: string) => ReactNode;
  /** The `id` of a heading, from its Markdown text, so anchors can find it. */
  headingId?: (text: string) => string | undefined;
  /** Whether `@name` renders as a mention chip; default true. */
  mentions?: boolean;
  /** The accessible name of a table's scroll area; default "Message table". */
  tableLabel?: string;
  /**
   * Join a paragraph's or quote's source lines with spaces, as a document renderer does. Chat
   * keeps each newline as a line break, so it is off by default.
   */
  softBreaks?: boolean;
}

const defaultText: TextRenderer = (text) => text;

interface Context {
  renderText: TextRenderer;
  options: MarkdownOptions;
}

const PLAIN: Context = { renderText: defaultText, options: {} };

interface Block {
  kind: "p" | "h" | "ul" | "ol" | "code" | "quote" | "hr" | "table";
  level?: number;
  lines: string[];
  items?: { text: string; children: string[] }[];
  lang?: string | undefined;
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const peek = () => lines[i] ?? "";
  while (i < lines.length) {
    const line = peek();
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      i += 1;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```\s*$/.test(peek())) {
        code.push(peek());
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", lines: code, lang: fence[1] || undefined });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "h",
        level: (heading[1] as string).length,
        lines: [heading[2] as string],
      });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "hr", lines: [] });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(peek())) {
        quote.push(peek().replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", lines: quote });
      continue;
    }
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch && (listMatch[1] as string).length < 4) {
      const ordered = /\d/.test(listMatch[2] as string);
      const items: { text: string; children: string[] }[] = [];
      while (i < lines.length) {
        const current = peek();
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(current);
        if (m && (m[1] as string).length < 4) {
          items.push({ text: m[3] as string, children: [] });
          i += 1;
          continue;
        }
        const nested = /^\s{2,}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(current);
        const last = items.at(-1);
        if (nested && last) {
          last.children.push(nested[1] as string);
          i += 1;
          continue;
        }
        if (current.trim() !== "" && last && /^\s{2,}\S/.test(current)) {
          last.text += ` ${current.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: ordered ? "ol" : "ul", lines: [], items });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const rows: string[] = [line];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(peek())) {
        rows.push(peek());
        i += 1;
      }
      blocks.push({ kind: "table", lines: rows });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const current = peek();
      if (
        current.trim() === "" ||
        /^\s*```/.test(current) ||
        /^#{1,3}\s/.test(current) ||
        /^\s*>/.test(current) ||
        (/^\s*([-*+]|\d+[.)])\s+/.test(current) && para.length > 0 && false)
      )
        break;
      if (para.length > 0 && /^\s*([-*+]|\d+[.)])\s+\S/.test(current)) break;
      para.push(current);
      i += 1;
    }
    blocks.push({ kind: "p", lines: para });
  }
  return blocks;
}

const URL_RE = /https?:\/\/[^\s<>()[\]{}"'`]+[^\s<>()[\]{}"'`.,;:!?]/;

function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** Inline grammar, applied left to right; the earliest match wins. */
const INLINE = [
  { kind: "code", re: /`([^`\n]+)`/ },
  { kind: "image", re: /!\[([^\]\n]*)\]\(([^)\s]+)\)/ },
  { kind: "link", re: /\[([^\]\n]+)\]\(([^)\s]+)\)/ },
  { kind: "bold", re: /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/ },
  { kind: "strike", re: /~~([^~\n]+?)~~/ },
  {
    kind: "italic",
    re: /(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/,
  },
  { kind: "url", re: URL_RE },
  { kind: "mention", re: /(?<![\w@])@([A-Za-z0-9_-]+)/ },
] as const;

function renderInline(text: string, ctx: Context, keyPrefix: string): ReactNode[] {
  const { renderText, options } = ctx;
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    let best:
      | { index: number; kind: (typeof INLINE)[number]["kind"]; match: RegExpExecArray }
      | undefined;
    for (const rule of INLINE) {
      if (rule.kind === "image" && !options.renderImage) continue;
      if (rule.kind === "mention" && options.mentions === false) continue;
      const match = rule.re.exec(rest);
      if (match && (best === undefined || match.index < best.index)) {
        best = { index: match.index, kind: rule.kind, match };
      }
    }
    if (!best) {
      out.push(renderText(rest, `${keyPrefix}-${n}`));
      break;
    }
    if (best.index > 0) out.push(renderText(rest.slice(0, best.index), `${keyPrefix}-${n}`));
    n += 1;
    const key = `${keyPrefix}-${n}`;
    const m = best.match;
    switch (best.kind) {
      case "code":
        out.push(<code key={key}>{m[1]}</code>);
        break;
      case "image":
        out.push(options.renderImage?.(m[2] as string, m[1] as string, key));
        break;
      case "link": {
        if (options.renderLink) {
          out.push(
            options.renderLink(m[2] as string, renderInline(m[1] as string, PLAIN, key), key),
          );
          break;
        }
        const href = safeHref(m[2] as string);
        out.push(
          href ? (
            <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
              {renderInline(m[1] as string, PLAIN, key)}
            </a>
          ) : (
            <span key={key}>{m[0]}</span>
          ),
        );
        break;
      }
      case "bold":
        out.push(<strong key={key}>{renderInline((m[1] ?? m[2]) as string, ctx, key)}</strong>);
        break;
      case "strike":
        out.push(<s key={key}>{renderInline(m[1] as string, ctx, key)}</s>);
        break;
      case "italic":
        out.push(<em key={key}>{renderInline((m[1] ?? m[2]) as string, ctx, key)}</em>);
        break;
      case "url":
        out.push(
          <a key={key} href={m[0]} target="_blank" rel="noopener noreferrer nofollow">
            {m[0]}
          </a>,
        );
        break;
      case "mention":
        out.push(
          <span key={key} className="mention">
            @{m[1]}
          </span>,
        );
        break;
    }
    rest = rest.slice(best.index + m[0].length);
    n += 1;
  }
  return out;
}

function renderLines(lines: string[], ctx: Context, key: string): ReactNode[] {
  if (ctx.options.softBreaks) return renderInline(lines.join(" "), ctx, `${key}-l0`);
  return lines.flatMap((line, i) => [
    // biome-ignore lint/suspicious/noArrayIndexKey: lines of one immutable body
    ...(i > 0 ? [<br key={`${key}-br-${i}`} />] : []),
    ...renderInline(line, ctx, `${key}-l${i}`),
  ]);
}

function renderBlock(block: Block, ctx: Context, key: string): ReactNode {
  switch (block.kind) {
    case "h": {
      const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
      const text = block.lines[0] ?? "";
      return (
        <Tag key={key} id={ctx.options.headingId?.(text)}>
          {renderInline(text, ctx, key)}
        </Tag>
      );
    }
    case "code":
      return (
        <pre key={key} data-lang={block.lang}>
          <code>{block.lines.join("\n")}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={key}>{renderLines(block.lines, ctx, key)}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "ul":
    case "ol": {
      const Tag = block.kind;
      return (
        <Tag key={key}>
          {(block.items ?? []).map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items of one immutable body
            <li key={i}>
              {renderInline(item.text, ctx, `${key}-${i}`)}
              {item.children.length > 0 ? (
                <ul>
                  {item.children.map((child, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: items of one immutable body
                    <li key={j}>{renderInline(child, ctx, `${key}-${i}-${j}`)}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </Tag>
      );
    }
    case "table": {
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim());
      const [head, ...body] = block.lines;
      return (
        <Table
          key={key}
          variant="secondary"
          aria-label={ctx.options.tableLabel ?? currentI18n().t("markdown.table")}
        >
          <TableHeader>
            <TableRow>
              {cells(head ?? "").map((cell, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells of one immutable row
                <TableHead key={i}>{renderInline(cell, ctx, `${key}-h${i}`)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {body.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows of one immutable table
              <TableRow key={r}>
                {cells(row).map((cell, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells of one immutable row
                  <TableCell key={c}>{renderInline(cell, ctx, `${key}-${r}-${c}`)}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
    }
    default:
      // A paragraph is a <div>, not a <p>: a text run may expand into a file card, which <p>
      // cannot contain.
      return (
        <div className="para" key={key}>
          {renderLines(block.lines, ctx, key)}
        </div>
      );
  }
}

/** Whether the text uses any Markdown construct worth a block renderer; plain text stays as is. */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s*(#{1,3}\s|[-*+]\s|\d+[.)]\s|>|```|\|)|\*\*|`|\[[^\]]+\]\(|https?:\/\//.test(
    text,
  );
}

export function Markdown({
  text,
  renderText = defaultText,
  options,
}: {
  text: string;
  renderText?: TextRenderer;
  options?: MarkdownOptions;
}) {
  const blocks = parseBlocks(text);
  const ctx: Context = { renderText, options: options ?? {} };
  return <>{blocks.map((block, i) => renderBlock(block, ctx, `b${i}`))}</>;
}
