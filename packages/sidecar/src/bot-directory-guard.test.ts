// T0: the bot-directory write guard (ADR-0038 decisions 2 to 6). A soft guard against mistakes,
// not a security boundary: these cases pin what it refuses, what it lets through on purpose
// (reads, the bot's own directory, the rest of /work) and what it cannot see.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type GuardRun, botDirectoryRefusal, shellRefusal } from "./bot-directory-guard.js";

const perBot: GuardRun = { botName: "nova", workdirMode: "per-bot", cwd: "/work/bots/nova" };
const shared: GuardRun = { botName: "nova", cwd: "/work" };

const file = (toolName: string, path: string, run: GuardRun = perBot) =>
  botDirectoryRefusal(
    toolName,
    toolName === "NotebookEdit" ? { notebook_path: path } : { file_path: path },
    "",
    false,
    run,
  );
const shell = (command: string, run: GuardRun = perBot) => shellRefusal(command, run);

describe("bot-directory guard: file tools", () => {
  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])(
    "%s into a teammate's directory is refused with where to write instead",
    (tool) => {
      const hit = file(tool, "/work/bots/orion/notes.md");
      expect(hit).toMatchObject({
        path: "/work/bots/orion/notes.md",
        area: "teammate",
        owner: "orion",
      });
      expect(hit?.message).toContain("orion's directory and is read-only to you");
      expect(hit?.message).toContain("your own directory, /work/bots/nova");
    },
  );

  it("resolves relative and `..` paths against the run's directory", () => {
    expect(file("Write", "../orion/x.md")?.owner).toBe("orion");
    expect(file("Write", "/work/bots/nova/../orion/x.md")?.owner).toBe("orion");
    expect(file("Write", "notes/x.md")).toBeUndefined();
  });

  it("allows the bot's own directory, /work, its home and /tmp", () => {
    for (const path of [
      "/work/bots/nova/a.md",
      "/work/bots/nova",
      "/work/shared/a.md",
      "/home/nova/MEMORY.md",
      "/tmp/x",
    ])
      expect(file("Write", path)).toBeUndefined();
  });

  it("never refuses a read", () => {
    expect(
      botDirectoryRefusal("Read", { file_path: "/work/bots/orion/a" }, "", false, perBot),
    ).toBeUndefined();
    expect(
      botDirectoryRefusal("Grep", { path: "/work/uploads" }, "", false, perBot),
    ).toBeUndefined();
  });

  it("keeps /work/uploads read-only in per-bot and shared mode", () => {
    expect(file("Write", "/work/uploads/2026-10-14/a.csv")?.area).toBe("uploads");
    expect(file("Edit", "/work/uploads/2026-10-14/a.csv", shared)?.area).toBe("uploads");
    expect(file("Edit", "/work/uploads/a.csv", shared)?.message).toContain(
      "uploaded and is read-only to bots",
    );
  });

  it("guards no teammate directory in shared mode", () => {
    expect(file("Write", "/work/bots/orion/notes.md", shared)).toBeUndefined();
  });
});

describe("bot-directory guard: shell", () => {
  it.each([
    "echo hi > /work/bots/orion/a.txt",
    "echo hi >>/work/bots/orion/a.txt",
    "make 2>&1 &> /work/bots/orion/log",
    "echo a>/work/bots/orion/b",
    "rm -rf /work/bots/orion/app",
    "rm -rf /work/bots/*",
    "mv /work/bots/orion/a.md ./a.md",
    "cp a.md /work/bots/orion/",
    "cp -t /work/bots/orion a.md b.md",
    "touch /work/bots/orion/x",
    "mkdir -p /work/bots/orion/new",
    "cat a | tee -a /work/bots/orion/log",
    "sed -i 's/a/b/' /work/bots/orion/a.md",
    "dd if=/dev/zero of=/work/bots/orion/blob bs=1 count=1",
    "sudo rm /work/bots/orion/x",
    "bash -c 'touch /work/bots/orion/x'",
    "echo $(touch /work/bots/orion/x)",
    "git -C /work/bots/orion/app commit -am wip",
    "cd /work/bots/orion/app && git add . && git commit -m x",
    "cd ../orion && touch x",
    "git --git-dir=/work/bots/orion/app/.git reset --hard",
    "git clone /work/app /work/bots/orion/app",
    "git push /work/bots/orion/app HEAD:main",
    "rm -rf /work/bots",
    "rm -rf /work",
    // #62 L17: output options and `<dir>/*`.
    "tar -xzf a.tgz -C /work/bots/orion",
    "tar xzf a.tgz -C /work/uploads/x",
    "tar --extract --file=a.tgz --directory=/work/bots/orion",
    "tar -czf /work/bots/orion/a.tgz .",
    "unzip a.zip -d /work/bots/orion/out",
    "unzip -o -d /work/bots/orion a.zip",
    "sort -o /work/bots/orion/sorted.txt a.txt",
    "sort -uo/work/bots/orion/sorted.txt a.txt",
    "sort --output=/work/bots/orion/sorted.txt a.txt",
    "curl -sSo /work/bots/orion/page.html https://example.test/",
    "curl -o /work/bots/orion/page.html https://example.test/",
    "curl --output /work/bots/orion/page.html https://example.test/",
    "curl --output-dir /work/bots/orion -O https://example.test/a",
    "wget -O /work/bots/orion/page.html https://example.test/",
    "wget -qO/work/bots/orion/page.html https://example.test/",
    "wget -P /work/bots/orion https://example.test/a",
    "wget --output-document=/work/bots/orion/p https://example.test/",
    "bash -lc 'touch /work/bots/orion/x'",
    "rm -rf /work/*",
    "rm -rf /*",
    "cd /work && rm -rf *",
    // #62: commands that write into the working directory after a `cd`, and archive tools.
    "cd /work/bots/orion && tar xzf /tmp/a.tgz",
    "cd /work/bots/orion && tar -x -f /tmp/a.tar",
    "cd /work/uploads && tar --extract --file=/tmp/a.tar",
    "cd /work/bots/orion && wget https://example.test/a",
    "cd /work/bots/orion && wget -q https://example.test/a",
    "cd /work/bots/orion && curl -O https://example.test/a",
    "cd /work/bots/orion && curl -sSLO https://example.test/a",
    "cd /work/bots/orion && unzip /tmp/a.zip",
    "zip -r /work/bots/orion/out.zip src",
    "zip -q -r ../orion/out.zip src",
    "zip -b /tmp -r /work/bots/orion/out.zip src",
    "zip -r out.zip src -O /work/bots/orion/copy.zip",
    "7z x -o/work/bots/orion /tmp/a.7z",
    "7z x /tmp/a.7z -o/work/bots/orion/out",
    "7za e /tmp/a.7z -o/work/uploads/x",
    "7z a /work/bots/orion/a.7z src",
    "cd /work/bots/orion && 7z x /tmp/a.7z",
  ])("refuses %s", (command) => {
    const hit = shell(command);
    expect(hit, command).toBeDefined();
    expect(hit?.message).toContain("bot_dirs_read_only");
  });

  it.each([
    "cat /work/bots/orion/a.md",
    "ls -la /work/bots/orion",
    "grep -r TODO /work/bots/orion",
    "cp /work/bots/orion/a.md ./a.md",
    "cp -r /work/bots/orion/app /work/bots/nova/app",
    "git -C /work/bots/orion/app log --oneline",
    "git -C /work/bots/orion/app status",
    "cd /work/bots/orion/app && git diff",
    "git clone /work/bots/orion/app",
    "git clone /work/bots/orion/app mine",
    "git fetch /work/bots/orion/app main",
    "git checkout -b bots/orion",
    "echo hi > notes.md",
    "make 2>&1 | tee build.log",
    "echo 'a > /work/bots/orion/x'",
    "rm -rf /work/old-checkout",
    "rm -rf /work/bots/nova/tmp",
    "mkdir -p /work/shared/out",
    "cat /work/uploads/2026-10-14/a.csv > a.csv",
    // #62 L17: reading from a protected directory, or writing elsewhere, is not refused.
    "tar -tzf /work/bots/orion/a.tgz",
    "tar -xzf /work/bots/orion/a.tgz -C /work/bots/nova/out",
    "tar -czf a.tgz -C /work/bots/orion .",
    "unzip /work/uploads/a.zip -d out",
    "sort -o sorted.txt /work/bots/orion/a.txt",
    "sort -k 2 /work/bots/orion/a.txt",
    "curl -o page.html https://example.test/",
    "curl -o - https://example.test/ > /tmp/x",
    "curl -H 'X-Out: /work/bots/orion/x' https://example.test/",
    "wget -O - https://example.test/",
    "wget -O page.html https://example.test/",
    "rm -rf /work/bots/nova/*",
    "rm -rf /work/old/*",
    // #62: the same commands reading from a teammate, listing, or writing elsewhere.
    "tar xzf /work/bots/orion/a.tgz",
    "cd /work/bots/orion && tar tzf a.tgz",
    "cd /work/bots/orion && tar -xOf a.tgz > /tmp/x",
    "cd /work/bots/orion && tar -xzf a.tgz -C /work/bots/nova/out",
    "cd /work/bots/orion && tar -czf /tmp/a.tgz .",
    "wget https://example.test/a",
    "cd /work/bots/orion && wget -O - https://example.test/",
    "cd /work/bots/orion && wget -qO- https://example.test/",
    "cd /work/bots/orion && wget -P /tmp https://example.test/a",
    "cd /work/bots/orion && wget --spider https://example.test/",
    "cd /work/bots/orion && curl -s https://example.test/",
    "cd /work/bots/orion && curl -O --output-dir /tmp https://example.test/a",
    "cd /work/bots/orion && unzip -l a.zip",
    "cd /work/bots/orion && unzip a.zip -d /tmp/out",
    "unzip /work/bots/orion/a.zip",
    "zip -r out.zip /work/bots/orion",
    "zip -r - /work/bots/orion > /tmp/a.zip",
    "7z x /work/bots/orion/a.7z -o/work/bots/nova/out",
    "7z x /work/bots/orion/a.7z",
    "7z l /work/bots/orion/a.7z",
    "7z a out.7z /work/bots/orion",
  ])("allows %s", (command) => {
    expect(shell(command), command).toBeUndefined();
  });

  it("refuses writes into uploads in shared mode too, and nothing in teammates' directories", () => {
    expect(shell("rm /work/uploads/2026-10-14/a.csv", shared)?.area).toBe("uploads");
    expect(shell("rm -rf /work", shared)?.area).toBe("uploads");
    expect(shell("rm -rf /work/bots/orion", shared)).toBeUndefined();
    expect(shell("rm -rf /work/bots", shared)).toBeUndefined();
  });

  it("is not a security boundary: run-time paths and interpreters are not seen", () => {
    for (const command of [
      "rm -rf $TEAMMATE_DIR",
      'python3 -c \'open("/work/bots/orion/x", "w")\'',
      'node -e \'require("fs").writeFileSync("/work/bots/orion/x", "")\'',
      "touch ~/../../work/bots/orion/x",
    ])
      expect(shell(command), command).toBeUndefined();
  });

  it("reaches the shell check through botDirectoryRefusal for a shell tool only", () => {
    const command = "touch /work/bots/orion/x";
    expect(botDirectoryRefusal("Bash", { command }, command, true, perBot)?.owner).toBe("orion");
    expect(botDirectoryRefusal("Other", { command }, command, false, perBot)).toBeUndefined();
  });
});

// AGENTS.md "Do not build access control between bots, except the directory guard" (test strategy
// §11): the guard is the one place a tool call is refused because a path belongs to another bot.
describe("bot-directory guard: the single exception", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("testing/"))
      .map((f) => join(dir, f));
  const here = fileURLToPath(new URL(".", import.meta.url));
  const files = [...sources(here), ...sources(join(here, "../../gateway/src"))];

  it("is the only source of the refusal reason, and only the PreToolUse hook calls it", () => {
    const reason = files.filter((f) => readFileSync(f, "utf8").includes("bot_dirs_read_only"));
    expect(reason.map((f) => basename(f))).toEqual(["bot-directory-guard.ts"]);
    const callers = files.filter((f) =>
      /botDirectoryRefusal\(|shellRefusal\(/.test(readFileSync(f, "utf8")),
    );
    expect(callers.map((f) => basename(f)).sort()).toEqual([
      "bot-directory-guard.ts",
      "pre-tool-use.ts",
    ]);
  });
});
