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

  it("previews source and config files as text and browser images, and nothing else (A6 decision 39)", () => {
    for (const path of ["ci.yaml", "main.py", "feed.xml", "query.sql", "fix.patch", "photo.avif"])
      expect(canPreviewWorkspacePath(`/work/${path}`), path).toBe(true);
    for (const path of ["bundle.zip", "tool.exe", "book.xlsx", "deck.ppt", "noextension"])
      expect(canPreviewWorkspacePath(`/work/${path}`), path).toBe(false);
  });

  it("previews AVIF only as a Blob image", async () => {
    render(<WorkspaceFilePreview api={apiFor("avif")} workspaceId={WS_ID} path="/work/a.avif" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    const image = await screen.findByRole("img", { name: "a.avif" });
    expect(image.getAttribute("src")).toBe("blob:preview");
    expect(vi.mocked(URL.createObjectURL).mock.calls[0]?.[0]).toMatchObject({
      type: "image/avif",
    });
  });

  it("shows XML as inert text without parsing it", async () => {
    render(
      <WorkspaceFilePreview
        api={apiFor('<?xml version="1.0"?><feed><script>x()</script></feed>')}
        workspaceId={WS_ID}
        path="/work/feed.xml"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    const preview = await screen.findByLabelText("Preview of /work/feed.xml");
    await waitFor(() => expect(preview.textContent).toContain("<feed><script>x()</script>"));
    expect(document.querySelector("script, feed")).toBeNull();
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
    expect(frame.getAttribute("srcdoc")).not.toContain("<script>");
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
    expect(
      document.querySelector(".detail-drawer-scroll svg:not(.lucide), .detail-drawer-scroll rect"),
    ).toBeNull();
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
    expect(
      document.querySelector(".detail-drawer-scroll svg:not(.lucide), .detail-drawer-scroll rect"),
    ).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("reports an undecodable image and keeps its native download available", async () => {
    render(
      <WorkspaceFilePreview
        api={apiFor("not an image")}
        workspaceId={WS_ID}
        path="/work/broken.png"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    fireEvent.error(await screen.findByRole("img", { name: "broken.png" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "broken.png: image unavailable",
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    expect(
      (screen.getByRole("button", { name: "Download /work/broken.png" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("keeps native streaming download available when preview fails", async () => {
    const api = apiFor("x");
    vi.mocked(api.readWorkspaceFileRange).mockRejectedValue(new Error("Workspace is not running"));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<WorkspaceFilePreview api={api} workspaceId={WS_ID} path="/work/report.txt" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The preview could not be opened. Download the file instead. Details: Workspace is not running",
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

describe("viewing controls (ADR-0014 amendment A6)", () => {
  it("source view shows the same bytes as text without another read and resets on close", async () => {
    const api = apiFor("# Title\n\n**bold**");
    render(<WorkspaceFilePreview api={api} workspaceId={WS_ID} path="/work/report.md" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByRole("heading", { name: "Title" });
    const reads = vi.mocked(api.readWorkspaceFileRange).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(document.querySelector(".workspace-file-source")?.textContent).toBe(
      "# Title\n\n**bold**",
    );
    expect(screen.queryByRole("heading", { name: "Title" })).toBeNull();
    expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(api.readWorkspaceFileRange).toHaveBeenCalledTimes(reads);
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByRole("heading", { name: "Title" });
    expect(screen.getByRole("button", { name: "Rendered" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("source view of HTML holds the script as text and mounts no script or frame", async () => {
    render(
      <WorkspaceFilePreview
        api={apiFor("<script>parent.x=1</script><p>Hi</p>")}
        workspaceId={WS_ID}
        path="/work/page.html"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByTitle("Isolated HTML preview of /work/page.html");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(document.querySelector(".workspace-file-source")?.textContent).toContain(
      "<script>parent.x=1</script>",
    );
    expect(document.querySelector("script, iframe")).toBeNull();
  });

  it("source view of SVG decodes the complete bytes as text, never as DOM", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    render(<WorkspaceFilePreview api={apiFor(svg)} workspaceId={WS_ID} path="/work/icon.svg" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByRole("img", { name: "icon.svg" });
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(document.querySelector(".workspace-file-source")?.textContent).toBe(svg);
    expect(document.querySelector(".detail-drawer-scroll rect")).toBeNull();
  });

  it("offers no Rendered view for a truncated JSON prefix", async () => {
    render(
      <WorkspaceFilePreview
        api={apiFor('{"a": [1, 2', 4 * 1024 * 1024)}
        workspaceId={WS_ID}
        path="/work/big.json"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByText(/preview is truncated/);
    expect(screen.queryByRole("button", { name: "Rendered" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(screen.getByText('{"a": [1, 2')).toBeTruthy();
  });

  it("renders CSV as a bounded table with column headers and states the extent", async () => {
    render(
      <WorkspaceFilePreview
        api={apiFor('name,note\n"Smith, Jo","said ""hi"""\n')}
        workspaceId={WS_ID}
        path="/work/people.csv"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    const header = await screen.findByRole("columnheader", { name: "name" });
    expect(header.getAttribute("scope")).toBe("col");
    expect(screen.getByRole("cell", { name: "Smith, Jo" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: 'said "hi"' })).toBeTruthy();
    expect(screen.getByText("Showing 1 row and 2 columns.")).toBeTruthy();
  });

  it("zooms an image within its steps and returns to Fit", async () => {
    render(<WorkspaceFilePreview api={apiFor("png")} workspaceId={WS_ID} path="/work/a.png" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    const image = (await screen.findByRole("img", { name: "a.png" })) as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 200 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 100 });
    fireEvent.load(image);
    const zoomIn = screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement;
    for (let i = 0; i < 10; i++) fireEvent.click(zoomIn);
    expect(screen.getByText("400%")).toBeTruthy();
    expect(zoomIn.disabled).toBe(true);
    expect(image.style.width).toBe("800px");
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(image.style.width).toBe("");
    for (let i = 0; i < 10; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText("25%")).toBeTruthy();
  });

  it("zooms a PDF page and refuses a page number that does not exist", async () => {
    render(
      <WorkspaceFilePreview
        api={apiFor("%PDF-1.7\n", 4 * 1024 * 1024)}
        workspaceId={WS_ID}
        path="/work/r.pdf"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByText("Page 1 of 1");
    const field = screen.getByRole("textbox", { name: "Go to page (1 to 1)" });
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.submit(field);
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a page number from 1 to 1.");
    expect(screen.getByText("Fit width")).toBeTruthy();
    const zoomIn = screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement;
    for (let i = 0; i < 10; i++) fireEvent.click(zoomIn);
    expect(screen.getByText("300%")).toBeTruthy();
    expect(zoomIn.disabled).toBe(true);
  });

  it("opens more than 16 previews in sequence, each with its own finished identity (#61 L2)", async () => {
    const body = "# Title\n\nbody";
    const api = apiFor(body);
    render(<WorkspaceFilePreview api={api} workspaceId={WS_ID} path="/work/report.md" />);
    const opens = 20;
    for (let i = 0; i < opens; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
      await screen.findByRole("heading", { name: "Title" });
      fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Title" })).toBeNull());
    }
    const calls = vi.mocked(api.readWorkspaceFileRange).mock.calls.map((call) => call[2]);
    const ids = new Set(calls.map((input) => input.previewId));
    // A fresh identity per open, so no reopen inherits a spent or expired budget; the Gateway
    // evicts the finished ones of this caller instead of refusing the next open.
    expect(ids.size).toBe(opens);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    // Each open reads its file to the last byte, which is what marks an identity finished.
    for (const id of ids) {
      const last = calls.filter((input) => input.previewId === id).at(-1);
      expect(last?.end).toBeGreaterThanOrEqual(new TextEncoder().encode(body).byteLength - 1);
    }
  });

  it("returns focus to the opener when the drawer closes", async () => {
    render(<WorkspaceFilePreview api={apiFor("x")} workspaceId={WS_ID} path="/work/a.txt" />);
    const opener = screen.getByRole("button", { name: "Preview file" });
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "a.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

it("retries a failed preview in the open drawer", async () => {
  const api = apiFor("Recovered file contents");
  vi.mocked(api.readWorkspaceFileRange).mockRejectedValueOnce(new Error("Temporary read failure"));
  render(<WorkspaceFilePreview api={api} workspaceId={WS_ID} path="/work/retry.txt" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Recovered file contents");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.readWorkspaceFileRange).toHaveBeenCalledTimes(2);
});

it("resets the open preview when its file identity changes", async () => {
  const api = apiFor("Old file contents");
  const view = render(<WorkspaceFilePreview api={api} workspaceId={WS_ID} path="/work/old.txt" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
  await screen.findByText("Old file contents");
  view.rerender(
    <WorkspaceFilePreview
      api={apiFor("New file contents")}
      workspaceId={WS_ID}
      path="/work/new.txt"
    />,
  );
  expect(screen.queryByText("Old file contents")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
  await screen.findByText("New file contents");
});
