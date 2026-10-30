// Parse without a live DOM so even malformed untrusted markup cannot fetch while being prepared.
import { type DefaultTreeAdapterTypes as Html, parse, parseFragment, serialize } from "parse5";

export const HTML_PREVIEW_POLICY =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
const REMOVED = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "link",
  "base",
  "portal",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);
const RESOURCE_ATTRIBUTES = new Set([
  "href",
  "xlink:href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "ping",
  "data",
  "codebase",
  "background",
]);
const element = (node: Html.Node): node is Html.Element => "tagName" in node;
const blocked = (node: Html.Node) =>
  element(node) &&
  (REMOVED.has(node.tagName.toLowerCase()) ||
    (node.tagName === "meta" && node.attrs.some((a) => a.name.toLowerCase() === "http-equiv")));

function label(node: Html.Node): string {
  let text = "";
  const queue = [node];
  while (queue.length && text.length < 300) {
    const next = queue.pop();
    if (!next) break;
    if (next.nodeName === "#text" && "value" in next) text += next.value;
    else if ("childNodes" in next)
      for (const child of [...next.childNodes].reverse()) queue.push(child);
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Preserve inline CSS and same-document anchors; external references become explicit UI links. */
export function prepareHtmlPreview(text: string): {
  document: string;
  links: { url: string; label: string }[];
} {
  const document = parse(text, { scriptingEnabled: false });
  const links = new Map<string, string>();
  const pending: Html.Node[] = [document];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (element(node)) {
      node.attrs = node.attrs.filter((attribute) => {
        const name =
          `${attribute.prefix ? `${attribute.prefix}:` : ""}${attribute.name}`.toLowerCase();
        const value = attribute.value.trim();
        if (name === "href" && node.tagName === "a" && /^https?:/i.test(value)) {
          try {
            const url = new URL(value);
            if (!url.username && !url.password && links.size < 100)
              links.set(url.href, label(node) || url.href);
          } catch {
            /* Invalid URLs stay inert. */
          }
        }
        const anchor = (name === "href" || name === "xlink:href") && /^#[^\s]*$/.test(value);
        const image =
          name === "src" &&
          node.tagName === "img" &&
          /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.test(value);
        return (
          !name.startsWith("on") &&
          name !== "is" &&
          name !== "srcdoc" &&
          name !== "target" &&
          (!RESOURCE_ATTRIBUTES.has(name) || anchor || image)
        );
      });
      if (node.tagName === "template") pending.push((node as Html.Template).content);
    }
    if ("childNodes" in node) {
      node.childNodes = node.childNodes.filter(
        (child) => child.nodeName !== "#documentType" && !blocked(child),
      );
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        const child = node.childNodes[index];
        if (child) pending.push(child);
      }
    }
  }
  const html = document.childNodes.find((node) => element(node) && node.tagName === "html");
  const head =
    html && element(html)
      ? html.childNodes.find((node) => element(node) && node.tagName === "head")
      : undefined;
  if (head && element(head)) {
    const policy = parseFragment(
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_POLICY}"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    ).childNodes;
    for (const node of policy) node.parentNode = head;
    head.childNodes.unshift(...policy);
  }
  return {
    document: `<!doctype html>${serialize(document)}`,
    links: [...links].map(([url, label]) => ({ url, label })),
  };
}
