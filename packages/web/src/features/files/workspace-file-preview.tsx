import {
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_RANGES,
  WORKSPACE_FILE_RANGE_BYTES,
  type WorkspaceId,
} from "@deskmates/contracts";
import { Download, ExternalLink, Eye, FileText, ZoomIn, ZoomOut } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button, ButtonLink } from "../../components/ui/button.js";
import { DetailPane, DetailPaneContent } from "../../components/ui/detail-pane.js";
import { DialogDescription, DialogTitle } from "../../components/ui/dialog.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { Markdown } from "../../lib/markdown.js";
import { CSV_PREVIEW_MAX_COLUMNS, parseDelimited } from "./csv-table.js";
import { formatFileSize } from "./file-size.js";
import { HtmlPreview } from "./html-preview.js";
import { downloadWorkspaceFile } from "./path-links.js";
import { PdfRangePreview } from "./pdf-range-preview.js";
import { IMAGE_ZOOM_STEPS, stepZoom } from "./preview-zoom.js";
import { fileReadHref } from "./route.js";
import {
  type WorkspaceFileRangeApi,
  WorkspaceFileRangeReader,
} from "./workspace-file-range-reader.js";

const TEXT_PREVIEW_BYTES = WORKSPACE_FILE_RANGE_BYTES;
const IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;
const HTML_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];
const HTML_EXTENSIONS = ["html", "htm", "xhtml"];
/** Types with a Rendered and a Source view (ADR-0014 amendment A6 decision 36). */
const SOURCE_VIEW_EXTENSIONS = ["md", "markdown", "json", "csv", "tsv", "svg", ...HTML_EXTENSIONS];
/** Inert text types: source and configuration files are never parsed (A6 decision 39). */
const INERT_TEXT =
  /\.(?:txt|log|ya?ml|toml|ini|cfg|conf|xml|py|[cm]?js|tsx?|jsx|sh|sql|css|go|rs|java|c|h|cpp|rb|diff|patch)$/i;
const PREVIEWABLE =
  /\.(?:md|markdown|csv|tsv|json|html?|xhtml|pdf|png|jpe?g|webp|gif|svg|avif|bmp)$/i;
const OFFICE = /\.(?:docx?|xlsx?|pptx?)$/i;

type PreviewApi = Pick<
  ApiClient,
  "readWorkspaceFileRange" | "workspaceFileDownloadUrl" | "downloadWorkspaceFile"
>;

interface PreviewBytes {
  bytes: Uint8Array;
  fileSize: number;
  truncated: boolean;
  ranges: number;
}

function extension(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).toLowerCase();
}

function hasControlBytes(body: string): boolean {
  return [...body].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
}

export function canPreviewWorkspacePath(path: string): boolean {
  return (PREVIEWABLE.test(path) || INERT_TEXT.test(path)) && !OFFICE.test(path);
}

export async function decodeWorkspacePreview(blob: Blob): Promise<string> {
  if (blob.size > TEXT_PREVIEW_BYTES)
    throw new Error(currentI18n().t("workspaceFilePreview.tooLarge"));
  const body = new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer());
  if (hasControlBytes(body)) throw new Error(currentI18n().t("workspaceFilePreview.binary"));
  return body;
}

/** Read sequential fixed-size ranges. The Gateway independently enforces the same 64/64 MiB cap. */
export async function readPreviewBytes(
  api: WorkspaceFileRangeApi,
  workspaceId: WorkspaceId,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<PreviewBytes> {
  const reader = new WorkspaceFileRangeReader(api, workspaceId, path, signal);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let fileSize = 0;
  let ranges = 0;
  const bounded = Math.min(maxBytes, WORKSPACE_FILE_PREVIEW_MAX_BYTES);
  while (offset < bounded && ranges < WORKSPACE_FILE_PREVIEW_MAX_RANGES) {
    const length = Math.min(WORKSPACE_FILE_RANGE_BYTES, bounded - offset);
    const result = await reader.read(offset, offset + length);
    const bytes = result.bytes;
    chunks.push(bytes);
    ranges += 1;
    fileSize = result.fileSize;
    offset += bytes.byteLength;
    if (bytes.byteLength === 0 || offset >= fileSize) break;
  }
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    joined.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return { bytes: joined, fileSize, truncated: joined.byteLength < fileSize, ranges };
}

export function decodeText(bytes: Uint8Array): string {
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (hasControlBytes(body)) throw new Error(currentI18n().t("workspaceFilePreview.binary"));
  return body;
}

function contentType(path: string): string {
  const ext = extension(path);
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (["png", "gif", "webp", "avif", "bmp"].includes(ext)) return `image/${ext}`;
  if (ext === "pdf") return "application/pdf";
  return "text/html;charset=utf-8";
}

function BlobPreview({
  bytes,
  path,
  onImageError,
}: {
  bytes: Uint8Array;
  path: string;
  onImageError?: (message: string) => void;
}) {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([bytes.slice().buffer], { type: contentType(path) })),
    [bytes, path],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const t = useT();
  const image = useRef<HTMLImageElement>(null);
  // undefined is "fit to the panel"; a number is a share of the natural size (A6 decision 38).
  const [zoom, setZoom] = useState<number>();
  const [natural, setNatural] = useState<{ width: number; height: number }>();
  const step = (direction: 1 | -1) => {
    const element = image.current;
    const fitted =
      element && element.naturalWidth > 0 && element.clientWidth > 0
        ? element.clientWidth / element.naturalWidth
        : 1;
    setZoom(stepZoom(IMAGE_ZOOM_STEPS, zoom ?? fitted, direction));
  };
  return (
    <div className="workspace-file-image-viewer">
      <div
        className="workspace-file-zoom"
        role="toolbar"
        aria-label={t("workspaceFilePreview.zoom")}
      >
        <Button
          type="button"
          aria-label={t("workspaceFilePreview.zoomOut")}
          disabled={zoom === IMAGE_ZOOM_STEPS[0]}
          onClick={() => step(-1)}
        >
          <ZoomOut size={16} aria-hidden="true" />
        </Button>
        <output>
          {zoom === undefined
            ? t("workspaceFilePreview.zoomFit")
            : t("workspaceFilePreview.zoomPercent", { percent: Math.round(zoom * 100) })}
        </output>
        <Button
          type="button"
          aria-label={t("workspaceFilePreview.zoomIn")}
          disabled={zoom === IMAGE_ZOOM_STEPS.at(-1)}
          onClick={() => step(1)}
        >
          <ZoomIn size={16} aria-hidden="true" />
        </Button>
        <Button type="button" disabled={zoom === undefined} onClick={() => setZoom(undefined)}>
          {t("workspaceFilePreview.zoomFit")}
        </Button>
      </div>
      <div className="workspace-file-image-frame">
        <img
          ref={image}
          className={`workspace-file-image${zoom === undefined ? "" : " zoomed"}`}
          src={url}
          alt={path.slice(path.lastIndexOf("/") + 1)}
          referrerPolicy="no-referrer"
          onError={() => {
            URL.revokeObjectURL(url);
            onImageError?.(
              currentI18n().t("workspaceFilePreview.imageUnavailable", {
                name: path.slice(path.lastIndexOf("/") + 1),
              }),
            );
          }}
          style={
            zoom !== undefined && natural
              ? { width: `${natural.width * zoom}px`, height: `${natural.height * zoom}px` }
              : undefined
          }
          onLoad={(event) => {
            const loaded = event.currentTarget;
            if (loaded.naturalWidth * loaded.naturalHeight > MAX_IMAGE_PIXELS) {
              URL.revokeObjectURL(url);
              onImageError?.(currentI18n().t("workspaceFilePreview.imagePixels"));
              return;
            }
            setNatural({ width: loaded.naturalWidth, height: loaded.naturalHeight });
          }}
        />
      </div>
    </div>
  );
}

function safeRelativePath(documentPath: string, src: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return undefined;
  const base = documentPath.slice(0, documentPath.lastIndexOf("/") + 1);
  const absolute = src.startsWith("/") ? src : `${base}${src}`;
  const out: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(segment);
  }
  const path = `/${out.join("/")}`;
  return path.startsWith("/work/") || path.startsWith("/home/") ? path : undefined;
}

async function boundedRemoteImage(response: Response): Promise<Blob> {
  if (!response.ok) throw new Error("remote image failed");
  if (response.headers.get("content-type")?.toLowerCase().startsWith("image/svg+xml"))
    throw new Error("SVG preview is unavailable");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > IMAGE_PREVIEW_BYTES)
    throw new Error("remote image exceeds preview limit");
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > IMAGE_PREVIEW_BYTES) throw new Error("remote image exceeds preview limit");
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > IMAGE_PREVIEW_BYTES) throw new Error("remote image exceeds preview limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  return new Blob(
    chunks.map((chunk) => chunk.slice().buffer),
    {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    },
  );
}

function MarkdownImage({
  api,
  workspaceId,
  documentPath,
  src,
  alt,
  remoteEnabled,
}: {
  api: PreviewApi;
  workspaceId: WorkspaceId;
  documentPath: string;
  src: string;
  alt: string;
  remoteEnabled: boolean;
}) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const remote = /^https:\/\//i.test(src);
  const relative = safeRelativePath(documentPath, src);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    if ((!remote || remoteEnabled) && (remote || relative)) {
      const read = remote
        ? fetch(src, {
            credentials: "omit",
            referrerPolicy: "no-referrer",
            mode: "cors",
            redirect: "error",
            signal: controller.signal,
          }).then(boundedRemoteImage)
        : readPreviewBytes(
            api,
            workspaceId,
            relative as string,
            IMAGE_PREVIEW_BYTES,
            controller.signal,
          ).then((value) => {
            if (value.truncated) throw new Error("image exceeds preview limit");
            return new Blob([value.bytes.slice().buffer]);
          });
      void read
        .then((blob) => {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name !== "AbortError") setFailed(true);
        });
    }
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, workspaceId, src, remoteEnabled, remote, relative]);
  if (/^https:\/\//i.test(src) && !remoteEnabled)
    return (
      <span className="muted">
        {currentI18n().t("workspaceFilePreview.remoteImageBlocked", { name: alt || src })}
      </span>
    );
  if (failed)
    return (
      <span className="muted">
        {currentI18n().t("workspaceFilePreview.imageUnavailable", { name: alt || src })}
      </span>
    );
  return url ? <img src={url} alt={alt} referrerPolicy="no-referrer" /> : <span>{alt}</span>;
}

function CsvPreview({
  text,
  delimiter,
  truncated,
}: {
  text: string;
  delimiter: string;
  truncated: boolean;
}) {
  const { t } = currentI18n();
  const table = parseDelimited(text, delimiter, truncated);
  const extent = [
    t("workspaceFilePreview.csvExtent", {
      rows: table.rows.length,
      columns: Math.min(table.totalColumns, CSV_PREVIEW_MAX_COLUMNS),
    }),
    table.moreRows ? t("workspaceFilePreview.csvMoreRows") : "",
    table.moreColumns
      ? t("workspaceFilePreview.csvMoreColumns", { columns: table.totalColumns })
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section className="workspace-file-csv-preview" aria-label={t("workspaceFilePreview.csvLabel")}>
      <p className="muted small workspace-file-csv-extent">{extent}</p>
      <div className="workspace-file-csv">
        <table>
          <thead>
            <tr>
              {table.header.map((cell, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: immutable preview cells
                <th key={c} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable preview rows
              <tr key={r}>
                {row.map((cell, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: immutable preview cells
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The bytes already read, as inert text; nothing more is read or rendered (A6 decision 36). */
function SourcePreview({ bytes }: { bytes: Uint8Array }) {
  let text: string;
  try {
    text = decodeText(bytes);
  } catch (error) {
    return <p role="alert">{(error as Error).message}</p>;
  }
  return <pre className="workspace-file-source">{text}</pre>;
}

function JsonTree({ value, name }: { value: unknown; name?: string }) {
  if (value === null || typeof value !== "object")
    return (
      <span>
        {name ? `${name}: ` : ""}
        {JSON.stringify(value)}
      </span>
    );
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <details open={name === undefined}>
      <summary>
        {name ??
          currentI18n().t(
            Array.isArray(value)
              ? "workspaceFilePreview.arrayLabel"
              : "workspaceFilePreview.objectLabel",
          )}
      </summary>
      <ul>
        {entries.map(([key, child]) => (
          <li key={key}>
            <JsonTree name={key} value={child} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function renderedPreview(
  api: PreviewApi,
  workspaceId: WorkspaceId,
  path: string,
  value: PreviewBytes,
  remoteEnabled: boolean,
  onError: (message: string) => void,
  view: PreviewView,
): ReactNode {
  const ext = extension(path);
  if (view === "source") return <SourcePreview bytes={value.bytes} />;
  if (IMAGE_EXTENSIONS.includes(ext))
    return <BlobPreview bytes={value.bytes} path={path} onImageError={onError} />;
  const text = decodeText(value.bytes);
  if (ext === "md" || ext === "markdown")
    return (
      <div className="workspace-file-markdown md">
        <Markdown
          text={text}
          options={{
            softBreaks: true,
            mentions: false,
            renderImage: (src, alt, key) => (
              <MarkdownImage
                key={key}
                api={api}
                workspaceId={workspaceId}
                documentPath={path}
                src={src}
                alt={alt}
                remoteEnabled={remoteEnabled}
              />
            ),
          }}
        />
      </div>
    );
  if (ext === "csv" || ext === "tsv")
    return (
      <CsvPreview text={text} delimiter={ext === "tsv" ? "\t" : ","} truncated={value.truncated} />
    );
  if (ext === "json" && !value.truncated) {
    try {
      return <JsonTree value={JSON.parse(text)} />;
    } catch {
      return <pre>{text}</pre>;
    }
  }
  if (HTML_EXTENSIONS.includes(ext)) return <HtmlPreview text={text} path={path} />;
  return <pre>{text}</pre>;
}

type PreviewView = "rendered" | "source";

/** Whether a loaded preview has a distinct Rendered view next to Source (A6 decision 36). */
function offersSourceView(path: string, value: PreviewBytes): boolean {
  const ext = extension(path);
  if (!SOURCE_VIEW_EXTENSIONS.includes(ext)) return false;
  // A truncated JSON prefix is source text only (decision 18); it has no Rendered view.
  return !(ext === "json" && value.truncated);
}

/** Safe, bounded rich preview of current workspace bytes. */
export function WorkspaceFilePreview(props: Parameters<typeof FilePreview>[0]) {
  return <FilePreview key={JSON.stringify([props.workspaceId, props.path])} {...props} />;
}

function FilePreview({
  api,
  workspaceId,
  path,
  describeError = errorMessage,
  onRead,
  compact = false,
  actionsOnly = false,
  inline = false,
  source,
  sourceId,
  card,
}: {
  api: PreviewApi;
  workspaceId: WorkspaceId;
  path: string;
  describeError?: (err: unknown) => string;
  onRead?: (bytes: number) => void;
  compact?: boolean;
  /** Parent already displays the file identity. */
  actionsOnly?: boolean;
  /** A filename link within chat prose; opens the same preview drawer. */
  inline?: boolean;
  source?: string;
  sourceId?: string;
  /** A message attachment card (ADR-0014 A5 decision 42): its name and size instead of the path. */
  card?: { name: string; sizeBytes?: number | undefined };
}) {
  const t = useT();
  const previewButton = useRef<HTMLButtonElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<PreviewBytes>();
  const [pdfSource, setPdfSource] = useState<{
    first: Awaited<ReturnType<WorkspaceFileRangeReader["read"]>>;
    reader: WorkspaceFileRangeReader;
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const [view, setView] = useState<PreviewView>("rendered");
  const controller = useRef<AbortController | undefined>(undefined);
  const ext = extension(path);

  const supported = canPreviewWorkspacePath(path);
  const hasRemoteImages = useMemo(
    () =>
      value && (ext === "md" || ext === "markdown")
        ? /!\[[^\]]*\]\(https:\/\/[^)\s]+\)/i.test(new TextDecoder().decode(value.bytes))
        : false,
    [value, ext],
  );

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const loadPreview = async () => {
    setOpen(true);
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setError("");
    setValue(undefined);
    setPdfSource(undefined);
    try {
      if (ext === "pdf") {
        pdfSource?.reader.abort();
        const reader = new WorkspaceFileRangeReader(api, workspaceId, path, next.signal);
        const first = await reader.read(0, WORKSPACE_FILE_RANGE_BYTES);
        if (next.signal.aborted) return;
        setValue(undefined);
        setPdfSource({ first, reader });
        onRead?.(first.fileSize);
        return;
      }
      const image = IMAGE_EXTENSIONS.includes(ext);
      const max = image
        ? IMAGE_PREVIEW_BYTES
        : HTML_EXTENSIONS.includes(ext)
          ? HTML_PREVIEW_BYTES
          : TEXT_PREVIEW_BYTES;
      const result = await readPreviewBytes(api, workspaceId, path, max, next.signal);
      if (next.signal.aborted) return;
      if (image && result.truncated) throw new Error(t("workspaceFilePreview.imageTooLarge"));
      if (!image) decodeText(result.bytes);
      setPdfSource(undefined);
      setValue(result);
      onRead?.(result.fileSize);
    } catch (err) {
      if (!next.signal.aborted && (err as { name?: string }).name !== "AbortError") {
        setValue(undefined);
        setError(describeError(err));
      }
    } finally {
      if (controller.current === next) setBusy(false);
    }
  };

  const download = () => {
    setDownloadError("");
    void downloadWorkspaceFile(api as ApiClient, workspaceId, path).catch((err) =>
      setDownloadError(describeError(err)),
    );
  };

  const content: ReactNode = value ? (
    renderedPreview(api, workspaceId, path, value, remoteEnabled, setError, view)
  ) : pdfSource ? (
    <PdfRangePreview source={pdfSource} path={path} onError={setError} />
  ) : undefined;

  const filename = path.split("/").at(-1) || path;
  const shortName = /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(filename)
    ? `${filename.slice(0, 8)}…${filename.slice(-5)}`
    : filename;
  const metadata = [
    source?.trim() ? t("chatInfo.fileBy", { name: source }) : "",
    /\.(md|markdown)$/i.test(path) ? "Markdown" : "",
    !supported ? t("workspaceFilePreview.unavailableShort") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const Container = inline ? "span" : "div";
  return (
    <Container
      className={`workspace-file-preview${actionsOnly ? " workspace-file-actions" : ""}${inline ? " workspace-file-inline" : ""}${compact ? " workspace-file-compact" : ""}${
        card ? " workspace-file-card" : ""
      }`}
    >
      {inline ? (
        <button
          ref={previewButton}
          type="button"
          className="workspace-file-link"
          title={path}
          aria-label={t(
            supported ? "workspaceFilePreview.previewLabel" : "workspaceFilePreview.downloadLabel",
            { path },
          )}
          disabled={busy}
          onClick={() => (supported ? void loadPreview() : download())}
        >
          <FileText size={14} aria-hidden="true" />
          {card?.name ?? filename}
        </button>
      ) : (
        <>
          {actionsOnly ? null : <FileText size={20} aria-hidden="true" />}
          {actionsOnly ? null : card ? (
            <span className="workspace-file-label" title={path}>
              <strong>{card.name}</strong>
              {card.sizeBytes === undefined ? null : (
                <span className="muted small">{formatFileSize(card.sizeBytes)}</span>
              )}
            </span>
          ) : compact ? (
            <details className="workspace-file-identity">
              <summary title={path} aria-label={`${t("workspaceFilePreview.details")}: ${path}`}>
                <strong>{shortName}</strong>
                <span className="muted small">{metadata || t("workspaceFilePreview.details")}</span>
              </summary>
              <div className="workspace-file-audit small">
                <code>{path}</code>
                {source?.trim() ? <span>{t("chatInfo.fileBy", { name: source })}</span> : null}
                {sourceId ? <code>{sourceId}</code> : null}
                <Button
                  onClick={() => {
                    void Promise.resolve()
                      .then(() =>
                        navigator.clipboard.writeText([path, sourceId].filter(Boolean).join("\n")),
                      )
                      .then(() => setCopyStatus(t("members.copy.done")))
                      .catch(() => setCopyStatus(t("members.copy.failed")));
                  }}
                >
                  {t("workspaceFilePreview.copyIdentity")}
                </Button>
                <output>{copyStatus}</output>
              </div>
            </details>
          ) : (
            <span className="workspace-file-label">
              <strong>{filename}</strong>
              <span className="muted small" title={path}>
                {path}
              </span>
            </span>
          )}
          {supported || compact || card ? (
            <Button
              ref={previewButton}
              type="button"
              disabled={busy || !supported}
              aria-label={
                compact || card ? t("workspaceFilePreview.previewLabel", { path }) : undefined
              }
              title={
                !supported
                  ? t("workspaceFilePreview.unavailableType")
                  : t("workspaceFilePreview.preview")
              }
              onClick={() => void loadPreview()}
            >
              {inline || compact || card ? (
                <Eye size={18} aria-hidden="true" />
              ) : busy ? (
                t("workspaceFilePreview.loading")
              ) : (
                t("workspaceFilePreview.preview")
              )}
            </Button>
          ) : (
            <span>{t("workspaceFilePreview.unavailableType")}</span>
          )}
        </>
      )}
      {HTML_EXTENSIONS.includes(ext) ? (
        <ButtonLink
          href={fileReadHref({ workspaceId, path })}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${t("workspaceFilePreview.openReader")}: ${path}`}
          title={t("workspaceFilePreview.openReader")}
        >
          {inline || compact || card ? (
            <ExternalLink size={18} aria-hidden="true" />
          ) : (
            t("workspaceFilePreview.openReader")
          )}
        </ButtonLink>
      ) : null}
      {!inline || !supported ? (
        <>
          <Button
            type="button"
            aria-label={t("workspaceFilePreview.downloadLabel", { path })}
            onClick={download}
          >
            {inline || compact || card ? (
              <Download size={18} aria-hidden="true" />
            ) : (
              t("workspaceFilePreview.download")
            )}
          </Button>
        </>
      ) : null}
      {downloadError ? (
        <span role="alert">
          {t("workspaceFilePreview.downloadError", { error: downloadError })}
        </span>
      ) : null}
      <DetailPane
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setBusy(false);
            controller.current?.abort();
            pdfSource?.reader.abort();
            setValue(undefined);
            setPdfSource(undefined);
            setRemoteEnabled(false);
            setView("rendered");
          }
        }}
      >
        <DetailPaneContent
          placement="right"
          className="detail-drawer file-preview-drawer"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previewButton.current?.focus();
          }}
          closeLabel={t("workspaceFilePreview.hide")}
        >
          <DialogTitle>{path.split("/").at(-1)}</DialogTitle>
          <DialogDescription className="muted small file-preview-path">{path}</DialogDescription>
          <div className="file-preview-toolbar">
            {HTML_EXTENSIONS.includes(ext) ? (
              <ButtonLink
                href={fileReadHref({ workspaceId, path })}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("workspaceFilePreview.openReader")}
              </ButtonLink>
            ) : null}
            <Button
              aria-label={t("workspaceFilePreview.downloadLabel", { path })}
              onClick={download}
            >
              {t("workspaceFilePreview.download")}
            </Button>
            {value && offersSourceView(path, value) ? (
              <div
                className="workspace-file-views"
                role="toolbar"
                aria-label={t("workspaceFilePreview.viewLabel")}
              >
                {(["rendered", "source"] as const).map((option) => (
                  <Button
                    key={option}
                    type="button"
                    aria-pressed={view === option}
                    onClick={() => setView(option)}
                  >
                    {t(
                      option === "rendered"
                        ? "workspaceFilePreview.viewRendered"
                        : "workspaceFilePreview.viewSource",
                    )}
                  </Button>
                ))}
              </div>
            ) : null}
            {hasRemoteImages && !remoteEnabled && view === "rendered" ? (
              <Fragment>
                <Button onClick={() => setRemoteEnabled(true)}>
                  {t("workspaceFilePreview.loadRemote")}
                </Button>
                <p className="muted small">{t("workspaceFilePreview.remoteWarning")}</p>
              </Fragment>
            ) : null}
          </div>
          <section
            className="detail-drawer-scroll"
            aria-label={t("workspaceFilePreview.previewLabel", { path })}
          >
            {busy ? <output>{t("workspaceFilePreview.loading")}</output> : null}
            {error ? (
              <div role="alert">
                <p>{t("workspaceFilePreview.previewError", { error })}</p>
                <Button disabled={busy} onClick={() => void loadPreview()}>
                  {t("files.retry")}
                </Button>
              </div>
            ) : null}
            {downloadError ? (
              <p role="alert">
                {t("workspaceFilePreview.downloadError", { error: downloadError })}
              </p>
            ) : null}
            {value?.truncated ? (
              <p className="files-truncated">{t("workspaceFilePreview.truncated")}</p>
            ) : null}
            {content}
          </section>
        </DetailPaneContent>
      </DetailPane>
    </Container>
  );
}
