// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { WS_ID } from "../../test-support/fixtures.js";
import {
  WorkspaceFilePreview,
  canPreviewWorkspacePath,
  decodeWorkspacePreview,
  readPreviewBytes,
} from "./workspace-file-preview.js";

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.mjs" }));

vi.mock("pdfjs-dist", () => {
  class FakeRangeTransport {
    constructor(
      readonly length: number,
      readonly initialData: Uint8Array,
    ) {}
    transportReady(): void {}
    onDataRange(): void {}
    onDataProgress(): void {}
    requestDataRange(_begin: number, _end: number): void {}
    abort(): void {}
  }
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    PDFDataRangeTransport: FakeRangeTransport,
    getDocument: (input: {
      length: number;
      range: FakeRangeTransport;
      rangeChunkSize: number;
      disableAutoFetch: boolean;
      disableStream: boolean;
    }) => {
      input.range.requestDataRange(input.length - input.rangeChunkSize, input.length);
      return {
        onPassword: undefined,
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getViewport: ({ scale }: { scale: number }) => ({
              width: 600 * scale,
              height: 800 * scale,
            }),
            render: () => ({ cancel: vi.fn(), promise: Promise.resolve() }),
          }),
          destroy: async () => undefined,
        }),
        destroy: async () => undefined,
      };
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});

function bytesBlob(bytes: Uint8Array): Blob {
  return {
    size: bytes.byteLength,
    type: "application/octet-stream",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as Blob;
}

function apiFor(text: string, total = new TextEncoder().encode(text).byteLength): ApiClient {
  const bytes = new TextEncoder().encode(text);
  return {
    readWorkspaceFileRange: vi.fn(async (_workspaceId, _path, input) => {
      const part = bytes.slice(input.start, Math.min(bytes.length, input.end + 1));
      return {
        blob: bytesBlob(part),
        fileSize: total,
        start: input.start,
        end: input.start + Math.max(0, part.byteLength - 1),
      };
    }),
    workspaceFileDownloadUrl: vi.fn(() => "/api/file"),
    downloadWorkspaceFile: vi.fn(async () => bytesBlob(bytes)),
  } as unknown as ApiClient;
}

describe("preview type policy", () => {
  it("supports rich safe types and keeps Office download-only", () => {
    for (const path of ["report.md", "data.JSON", "page.html", "image.png", "vector.svg", "x.pdf"])
      expect(canPreviewWorkspacePath(`/work/${path}`), path).toBe(true);
    for (const path of ["report.docx", "sheet.xlsx", "slides.pptx", "binary.exe"])
      expect(canPreviewWorkspacePath(`/work/${path}`), path).toBe(false);
  });

  it("rejects oversized, binary and malformed UTF-8 source bytes", async () => {
    await expect(decodeWorkspacePreview({ size: 1024 * 1024 + 1 } as Blob)).rejects.toThrow(
      /1 MiB/,
    );
    await expect(decodeWorkspacePreview(bytesBlob(new Uint8Array([0, 1])))).rejects.toThrow(
      /binary/,
    );
    await expect(decodeWorkspacePreview(bytesBlob(new Uint8Array([0xff])))).rejects.toThrow();
  });

  it("bounds range accounting and marks a file above 1 GiB as a partial preview", async () => {
    const api = apiFor("prefix", 2 * 1024 * 1024 * 1024);
    const result = await readPreviewBytes(api, WS_ID, "/work/huge.txt", 1024 * 1024);
    expect(new TextDecoder().decode(result.bytes)).toBe("prefix");
    expect(result.truncated).toBe(true);
    expect(result.ranges).toBe(2);
    expect(api.readWorkspaceFileRange).toHaveBeenCalledTimes(2);
  });

  it("renders the first page of a file above 1 GiB with bounded first-and-tail PDF ranges", async () => {
    const total = 2 * 1024 * 1024 * 1024;
    const api = apiFor("%PDF-1.7\n", total);
    render(<WorkspaceFilePreview api={api} workspaceId={WS_ID} path="/work/huge-report.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByLabelText("PDF preview of /work/huge-report.pdf");
    await waitFor(() => expect(api.readWorkspaceFileRange).toHaveBeenCalledTimes(2));
    const [first, tail] = vi.mocked(api.readWorkspaceFileRange).mock.calls;
    expect(first?.[2]).toMatchObject({ start: 0, end: 1024 * 1024 - 1 });
    expect(tail?.[2]).toMatchObject({
      start: total - 1024 * 1024,
      end: total - 1,
      previewId: first?.[2].previewId,
    });
    expect(screen.getByText("Page 1 of 1")).toBeTruthy();
    expect(api.downloadWorkspaceFile).not.toHaveBeenCalled();
  });
});

describe("safe renderers", () => {
  it("renders Markdown through React and keeps raw HTML inert", async () => {
    const body = "# Result\n<script>alert('x')</script>";
    const { container } = render(
      <WorkspaceFilePreview api={apiFor(body)} workspaceId={WS_ID} path="/work/report.md" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    const preview = await screen.findByLabelText("Preview of /work/report.md");
    await waitFor(() => expect(preview.textContent).toContain("<script>alert('x')</script>"));
    expect(screen.getByRole("dialog", { name: "report.md" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Result" })).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });

  it("loads an HTTPS Markdown image only after the per-file click and omits credentials", async () => {
    const remote = "https://images.example/chart.png";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    render(
      <WorkspaceFilePreview
        api={apiFor(`![Quarterly chart](${remote})`)}
        workspaceId={WS_ID}
        path="/work/report.md"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByText(/remote image blocked/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load remote images" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      remote,
      expect.objectContaining({ credentials: "omit", referrerPolicy: "no-referrer", mode: "cors" }),
    );
  });

  it("fails an oversized remote image harmlessly without creating a Blob URL", async () => {
    const remote = "https://images.example/huge.png";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-length": String(16 * 1024 * 1024 + 1) },
      }),
    );
    render(
      <WorkspaceFilePreview
        api={apiFor(`![Huge chart](${remote})`)}
        workspaceId={WS_ID}
        path="/work/report.md"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByText(/remote image blocked/);
    fireEvent.click(screen.getByRole("button", { name: "Load remote images" }));
    await screen.findByText(/image unavailable/);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("puts HTML in an opaque offline sandbox and never mounts its script in the app DOM", async () => {
    const { container } = render(
      <WorkspaceFilePreview
        api={apiFor("<script>parent.document.body.textContent='owned'</script><h1>Report</h1>")}
        workspaceId={WS_ID}
        path="/work/report.html"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    const frame = (await screen.findByTitle(
      "Isolated HTML preview of /work/report.html",
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("sandbox; default-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("<script>");
    expect(document.querySelector("script")).toBeNull();
  });

  it("renders raster images through a Blob URL and revokes it on hide", async () => {
    const { container } = render(
      <WorkspaceFilePreview
        api={apiFor("raster bytes")}
        workspaceId={WS_ID}
        path="/work/chart.png"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    const image = await screen.findByRole("img", { name: "chart.png" });
    expect(image.getAttribute("src")).toBe("blob:preview");
    expect(document.querySelector(".detail-drawer-scroll svg")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview"));
  });

  it("renders complete SVG bytes only as a revocable Blob image", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.document.body.textContent="owned"</script><rect width="10" height="10"/></svg>';
    const { container } = render(
      <WorkspaceFilePreview api={apiFor(svg)} workspaceId={WS_ID} path="/work/chart.svg" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    const image = await screen.findByRole("img", { name: "chart.svg" });
    expect(image.getAttribute("src")).toBe("blob:preview");
    expect(document.querySelector(".detail-drawer-scroll svg")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("keeps native streaming download available when preview fails", async () => {
    const api = apiFor("x");
    vi.mocked(api.readWorkspaceFileRange).mockRejectedValue(new Error("Workspace is not running"));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<WorkspaceFilePreview api={api} workspaceId={WS_ID} path="/work/report.txt" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Preview unavailable: Workspace is not running",
    );
    fireEvent.click(screen.getByRole("button", { name: "Download /work/report.txt" }));
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe("compact audit rows", () => {
  it("keeps an unknown ID downloadable without inventing metadata or reading bytes", async () => {
    const api = apiFor("");
    const path = "d8ac46ac-97dd-4908-ae58-af32cca89a9c";
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const { container } = render(
      <WorkspaceFilePreview api={api} workspaceId={WS_ID} path={path} compact source="" />,
    );
    expect(screen.getByText("d8ac46ac…89a9c")).toBeTruthy();
    expect(screen.getByText("Preview unavailable")).toBeTruthy();
    expect(container.textContent).not.toContain("by ");
    expect(
      (screen.getByRole("button", { name: `Preview of ${path}` }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.readWorkspaceFileRange).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector("summary") as HTMLElement);
    expect(container.querySelector("code")?.textContent).toBe(path);
    fireEvent.click(screen.getByRole("button", { name: "Copy path and source ID" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(path));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: `Download ${path}` }));
    expect(click).toHaveBeenCalledOnce();
  });

  it("reenables the preview trigger when a pending read is closed", async () => {
    const api = apiFor("");
    vi.mocked(api.readWorkspaceFileRange).mockImplementation(() => new Promise(() => {}));
    render(<WorkspaceFilePreview api={api} workspaceId={WS_ID} path="/work/pending.txt" compact />);
    const trigger = screen.getByRole("button", {
      name: "Preview of /work/pending.txt",
    }) as HTMLButtonElement;
    fireEvent.click(trigger);
    expect(trigger.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    await waitFor(() => expect(trigger.disabled).toBe(false));
  });

  it("retains complete long paths and unresolved actors in details", () => {
    const path = `/work/${"long-directory/".repeat(30)}result.md`;
    const { container } = render(
      <WorkspaceFilePreview
        api={apiFor("")}
        workspaceId={WS_ID}
        path={path}
        compact
        source="bot_unknown"
        sourceId="bot_unknown"
      />,
    );
    expect(container.querySelector("summary")?.textContent).toContain("by bot_unknown · Markdown");
    expect([...container.querySelectorAll("code")].map((node) => node.textContent)).toEqual([
      path,
      "bot_unknown",
    ]);
    expect(container.querySelector("summary")?.title).toBe(path);
  });
});
