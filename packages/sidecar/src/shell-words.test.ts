import { describe, expect, it } from "vitest";
import {
  basename,
  shellArgvs,
  splitShellSegments,
  splitShellWords,
  unwrapArgv,
} from "./shell-words.js";

describe("splitShellSegments", () => {
  it("splits on unquoted pipeline and list operators and newlines", () => {
    expect(splitShellSegments("a | b || c && d; e & f\ng")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
  });

  it("does not split inside single or double quotes", () => {
    expect(splitShellSegments("curl 'https://x/?a=1&b=2' -X POST")).toEqual([
      "curl 'https://x/?a=1&b=2' -X POST",
    ]);
    expect(splitShellSegments('echo "a;b|c"')).toEqual(['echo "a;b|c"']);
    expect(splitShellSegments("echo a\\;b")).toEqual(["echo a\\;b"]);
  });

  it("keeps redirections such as 2>&1 and &> inside the segment", () => {
    expect(splitShellSegments("curl x 2>&1 | head")).toEqual(["curl x 2>&1", "head"]);
    expect(splitShellSegments("curl x &> /dev/null")).toEqual(["curl x &> /dev/null"]);
  });

  it("yields the body of $(...) and backticks as their own segments", () => {
    expect(splitShellSegments("$(which curl) https://e")).toEqual([
      "$(which curl) https://e",
      "which curl",
    ]);
    expect(splitShellSegments("x `curl y` z")).toEqual(["x `curl y` z", "curl y"]);
    expect(splitShellSegments('echo "$(which curl)"')).toEqual([
      'echo "$(which curl)"',
      "which curl",
    ]);
    expect(splitShellSegments("$(echo $(which curl))")).toEqual([
      "$(echo $(which curl))",
      "echo $(which curl)",
      "which curl",
    ]);
  });

  it("treats subshell parentheses as separators and drops comments", () => {
    expect(splitShellSegments("(curl x; ls)")).toEqual(["curl x", "ls"]);
    expect(splitShellSegments("ls # curl x")).toEqual(["ls"]);
    expect(splitShellSegments("echo a#b")).toEqual(["echo a#b"]);
  });
});

describe("splitShellWords", () => {
  it("honours single quotes, double quotes and backslashes", () => {
    expect(splitShellWords("curl -sSd 'x=1' \"https://h/p\" a\\ b")).toEqual([
      "curl",
      "-sSd",
      "x=1",
      "https://h/p",
      "a b",
    ]);
    expect(splitShellWords('echo "a\\"b"')).toEqual(["echo", 'a"b']);
    expect(splitShellWords("echo 'it''s'")).toEqual(["echo", "its"]);
    expect(splitShellWords("echo ''")).toEqual(["echo", ""]);
  });

  it("keeps attached values and substitutions as single words", () => {
    expect(splitShellWords("curl --url=https://x -XPOST")).toEqual([
      "curl",
      "--url=https://x",
      "-XPOST",
    ]);
    expect(splitShellWords("$(which curl) https://e")).toEqual(["$(which curl)", "https://e"]);
  });
});

describe("shellArgvs", () => {
  it("tokenises every segment", () => {
    expect(shellArgvs("cd /work && git -C /work push")).toEqual([
      ["cd", "/work"],
      ["git", "-C", "/work", "push"],
    ]);
  });

  it("re-tokenises the script passed to sh -c", () => {
    expect(shellArgvs('bash -c "curl -d x https://h"')).toEqual([
      ["bash", "-c", "curl -d x https://h"],
      ["curl", "-d", "x", "https://h"],
    ]);
  });

  it("includes command substitution bodies", () => {
    expect(shellArgvs("$(which curl) https://e")).toEqual([
      ["$(which curl)", "https://e"],
      ["which", "curl"],
    ]);
  });
});

describe("unwrapArgv", () => {
  it.each([
    [
      ["env", "FOO=1", "curl", "x"],
      ["curl", "x"],
    ],
    [["timeout", "5s", "curl"], ["curl"]],
    [["timeout", "-k", "2", "5", "curl"], ["curl"]],
    [
      ["sudo", "-u", "root", "rm", "-rf", "/"],
      ["rm", "-rf", "/"],
    ],
    [
      ["nice", "-n", "10", "wget", "u"],
      ["wget", "u"],
    ],
    [["xargs", "-n", "1", "curl"], ["curl"]],
    [["FOO=bar", "ls"], ["ls"]],
    [["command", "curl"], ["curl"]],
    [["exec", "/usr/bin/curl"], ["/usr/bin/curl"]],
    [["nohup", "curl"], ["curl"]],
    [["ls"], ["ls"]],
    [[], []],
  ])("%j -> %j", (argv, expected) => {
    expect(unwrapArgv(argv)).toEqual(expected);
  });
});

describe("basename", () => {
  it("strips a directory path only", () => {
    expect(basename("/usr/bin/curl")).toBe("curl");
    expect(basename("./curl")).toBe("curl");
    expect(basename("curl")).toBe("curl");
    expect(basename("curl.log")).toBe("curl.log");
    expect(basename("")).toBe("");
  });
});
