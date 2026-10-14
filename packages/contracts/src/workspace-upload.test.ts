import { describe, expect, it } from "vitest";
import { workspaceFileRoot } from "./workspace-file.js";
import {
  WORKSPACE_UPLOAD_NAME,
  WORKSPACE_UPLOAD_NAME_MAX,
  sanitizeUploadName,
  uploadDateDir,
  uploadLabel,
} from "./workspace-upload.js";

describe("sanitizeUploadName (ADR-0014 A5 decision 29)", () => {
  it.each([
    ["report.pdf", "report.pdf"],
    ["../../etc/passwd", "passwd"],
    ["..\\..\\Windows\\win.ini", "win.ini"],
    ["/profile/Cookies", "Cookies"],
    ["a b (1).PDF", "a_b_1.PDF"],
    ["报告.pdf", "upload.pdf"],
    ["季度 report.csv", "report.csv"],
    [".bashrc", "upload.bashrc"],
    ["...", "upload"],
    ["..", "upload"],
    ["", "upload"],
    ["-rf", "rf"],
    ["__init__.py", "init.py"],
    ["name\u0000.txt", "name.txt"],
    ["x.tar.gz", "x.tar.gz"],
  ])("%j becomes %j", (raw, expected) => {
    expect(sanitizeUploadName(raw)).toBe(expected);
  });

  it("keeps the extension when it shortens a long name", () => {
    const name = sanitizeUploadName(`${"a".repeat(300)}.xlsx`);
    expect(name.length).toBe(WORKSPACE_UPLOAD_NAME_MAX);
    expect(name.endsWith(".xlsx")).toBe(true);
  });

  it("always yields a name the download path policy accepts", () => {
    for (const raw of ["../x", "a/b/../../c", "‮gnp.exe", "a\nb", "  ", "😀.png", "%2e%2e"]) {
      const name = sanitizeUploadName(raw);
      expect(name).toMatch(WORKSPACE_UPLOAD_NAME);
      expect(workspaceFileRoot(`/work/uploads/2026-10-14/${name}`, [])).toBe("/work");
    }
  });
});

describe("uploadLabel and uploadDateDir", () => {
  it("strips control characters and bounds the label", () => {
    expect(uploadLabel("报告\n.pdf")).toBe("报告.pdf");
    expect(uploadLabel("\u0000")).toBe("upload");
    expect(uploadLabel("x".repeat(400)).length).toBe(255);
  });

  it("names the UTC date", () => {
    expect(uploadDateDir(new Date("2026-10-14T23:59:59.000Z"))).toBe("2026-10-14");
  });
});
