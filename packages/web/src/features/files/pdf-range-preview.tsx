import { WORKSPACE_FILE_RANGE_BYTES } from "@deskmates/contracts";
import type { PDFDataRangeTransport, PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import type {
  WorkspaceFileRange,
  WorkspaceFileRangeReader,
} from "./workspace-file-range-reader.js";

interface PdfSource {
  first: WorkspaceFileRange;
  reader: WorkspaceFileRangeReader;
}

interface PdfRuntime {
  PDFDataRangeTransport: typeof PDFDataRangeTransport;
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (input: Record<string, unknown>) => PDFDocumentLoadingTask;
}

class PdfRangeFailure extends Error {}

async function loadPdfRuntime(): Promise<PdfRuntime> {
  const runtime = await import("pdfjs-dist");
  runtime.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return runtime as unknown as PdfRuntime;
}

function createRangeTransport(
  runtime: PdfRuntime,
  source: PdfSource,
  onFailure: (error: unknown) => void,
): PDFDataRangeTransport {
  const { first, reader } = source;
  class WorkspaceRangeTransport extends runtime.PDFDataRangeTransport {
    #queue = Promise.resolve();
    #failed = false;

    constructor() {
      // The initial prefix is complete; later bytes arrive only through requestDataRange. Without
      // this flag PDF.js waits for a progressive stream and may walk the file sequentially.
      super(first.fileSize, first.bytes, true);
      this.transportReady();
    }

    override requestDataRange(begin: number, end: number): void {
      if (this.#failed) return;
      this.#queue = this.#queue
        .then(async () => {
          for (let start = begin; start < end; start += WORKSPACE_FILE_RANGE_BYTES) {
            const part = await reader.read(
              start,
              Math.min(end, start + WORKSPACE_FILE_RANGE_BYTES),
            );
            if (part.fileSize !== first.fileSize)
              throw new PdfRangeFailure(
                currentI18n().t("workspaceFilePreview.pdfChangedDuringPreview"),
              );
            this.onDataRange(start, part.bytes);
            this.onDataProgress(reader.bytes, first.fileSize);
          }
        })
        .catch((error: unknown) => {
          this.#failed = true;
          reader.abort();
          onFailure(error);
        });
    }

    override abort(): void {
      reader.abort();
    }
  }
  return new WorkspaceRangeTransport();
}

function printableError(error: unknown): string {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : "";
  if (name === "PasswordException") return currentI18n().t("workspaceFilePreview.pdfEncrypted");
  if (error instanceof Error && error.message) return error.message;
  return currentI18n().t("workspaceFilePreview.pdfUnsupported");
}

/** Render one page while PDF.js asks the existing authenticated route only for needed ranges. */
export function PdfRangePreview({
  source,
  path,
  onError,
}: {
  source: PdfSource;
  path: string;
  onError: (message: string) => void;
}) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const loadingTask = useRef<PDFDocumentLoadingTask | undefined>(undefined);
  const document = useRef<PDFDocumentProxy | undefined>(undefined);
  const renderTask = useRef<{ cancel(): void; promise: Promise<unknown> } | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    const fail = (error: unknown) => {
      if (live) {
        setBusy(false);
        onError(printableError(error));
      }
    };
    void loadPdfRuntime()
      .then(async (runtime) => {
        if (!live) return;
        const range = createRangeTransport(runtime, source, fail);
        const task = runtime.getDocument({
          range,
          length: source.first.fileSize,
          rangeChunkSize: WORKSPACE_FILE_RANGE_BYTES,
          disableAutoFetch: true,
          disableStream: true,
          stopAtErrors: true,
          isEvalSupported: false,
          maxImageSize: 40_000_000,
          useWorkerFetch: false,
          useWasm: false,
        });
        loadingTask.current = task;
        task.onPassword = () => fail({ name: "PasswordException" });
        const pdf = await task.promise;
        if (!live) {
          await pdf.destroy();
          return;
        }
        document.current = pdf;
        setPages(pdf.numPages);
      })
      .catch(fail);
    return () => {
      live = false;
      renderTask.current?.cancel();
      source.reader.abort();
      void loadingTask.current?.destroy();
      void document.current?.destroy();
    };
  }, [source, onError]);

  useEffect(() => {
    const pdf = document.current;
    const target = canvas.current;
    if (!pdf || !target || pages === 0) return;
    let live = true;
    setBusy(true);
    void pdf
      .getPage(page)
      .then((pdfPage) => {
        if (!live) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const available = target.parentElement?.clientWidth ?? base.width;
        const cssScale = Math.min(1.5, Math.max(0.25, available / base.width));
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = pdfPage.getViewport({ scale: cssScale * ratio });
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        target.style.width = `${Math.ceil(viewport.width / ratio)}px`;
        target.style.height = `${Math.ceil(viewport.height / ratio)}px`;
        const context = target.getContext("2d", { alpha: false });
        if (!context) throw new Error(currentI18n().t("workspaceFilePreview.pdfCanvasUnavailable"));
        const task = pdfPage.render({
          canvas: target,
          canvasContext: context,
          viewport,
          background: "#ffffff",
        });
        renderTask.current = task;
        return task.promise;
      })
      .then(() => {
        if (live) setBusy(false);
      })
      .catch((error: unknown) => {
        if (live && (error as { name?: string }).name !== "RenderingCancelledException")
          onError(printableError(error));
      });
    return () => {
      live = false;
      renderTask.current?.cancel();
    };
  }, [page, pages, onError]);

  return (
    <div className="workspace-file-pdf" aria-label={t("workspaceFilePreview.pdfLabel", { path })}>
      <div className="workspace-file-pdf-controls">
        <Button
          type="button"
          disabled={busy || page === 1}
          onClick={() => setPage((value) => value - 1)}
        >
          {t("workspaceFilePreview.previousPage")}
        </Button>
        <span>
          {pages > 0
            ? t("workspaceFilePreview.pageCount", { page, pages })
            : t("workspaceFilePreview.loading")}
        </span>
        <Button
          type="button"
          disabled={busy || pages === 0 || page === pages}
          onClick={() => setPage((value) => value + 1)}
        >
          {t("workspaceFilePreview.nextPage")}
        </Button>
      </div>
      <canvas ref={canvas} aria-label={t("workspaceFilePreview.pdfPageLabel", { page })} />
    </div>
  );
}
