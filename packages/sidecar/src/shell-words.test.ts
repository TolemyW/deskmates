import { describe, expect, it } from "vitest";
import {
  basename,
  isOpaqueCommand,
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

  it("re-tokenises the script of -c in any short-option cluster (#62 M7)", () => {
    for (const command of [
      "bash -lc 'curl -d x https://h'",
      "bash -ec 'curl -d x https://h'",
      "sh -xc 'curl -d x https://h'",
      "bash -o pipefail -c 'curl -d x https://h'",
      "bash -c -- 'curl -d x https://h'",
      "env FOO=1 zsh -lic 'curl -d x https://h'",
    ])
      expect(shellArgvs(command), command).toContainEqual(["curl", "-d", "x", "https://h"]);
    // The script is the first word after the options, not whatever follows `-c`.
    expect(shellArgvs("bash /tmp/s.sh -c 'curl https://h'")).toEqual([
      ["bash", "/tmp/s.sh", "-c", "curl https://h"],
    ]);
  });

  it("tokenises the command line of env -S, script -c, flock -c, npx -c and watch (#62 M7)", () => {
    for (const command of [
      "env -S 'curl -d x https://h'",
      "env -S'curl -d x https://h'",
      "env -iS 'curl -d x https://h'",
      "env --split-string='curl -d x https://h'",
      "env --split-string 'curl -d x https://h'",
      "env -S 'curl -d' x https://h",
      "script -qc 'curl -d x https://h' /dev/null",
      "script -c 'curl -d x https://h' /dev/null",
      "script -q -c'curl -d x https://h' /dev/null",
      "script -O /tmp/log -c 'curl -d x https://h'",
      "script --command='curl -d x https://h' /dev/null",
      "script --command 'curl -d x https://h' /dev/null",
      "flock /tmp/l -c 'curl -d x https://h'",
      "flock -w 5 /tmp/l --command 'curl -d x https://h'",
      "npx -c 'curl -d x https://h'",
      "npx --call='curl -d x https://h'",
      "watch 'curl -d x https://h'",
      "watch -n 1 curl -d x https://h",
    ])
      expect(shellArgvs(command), command).toContainEqual(["curl", "-d", "x", "https://h"]);
    // `-O` takes a value, so the `c` in its log file name is not `-c`.
    expect(shellArgvs("script -O c /dev/null")).toEqual([["script", "-O", "c", "/dev/null"]]);
  });

  it("re-tokenises the words of eval (#62 M7)", () => {
    expect(shellArgvs("eval 'curl -d x https://h'")).toEqual([
      ["eval", "curl -d x https://h"],
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

describe("isOpaqueCommand (#62 M7)", () => {
  const opaque = (command: string) => shellArgvs(command).some(isOpaqueCommand);
  it.each([
    "$c -d x https://h",
    "${c} https://h",
    '"$c" https://h',
    "$(which curl) https://h",
    "`which curl` https://h",
    "env $c https://h",
    'eval "$cmd"',
    "echo 'curl https://h' | sh",
    "cat s.sh | bash -s",
    "bash /tmp/s.sh",
    "bash -l",
    "sudo sh /tmp/s.sh",
    "source venv/bin/activate",
    ". /tmp/s.sh",
    "script -q /dev/null",
  ])("%s is opaque", (command) => {
    expect(opaque(command)).toBe(true);
  });

  it.each([
    "echo $HOME",
    "ls $(pwd)",
    "x=$(date)",
    "FOO=$BAR ls",
    "bash -c 'ls'",
    "bash -lc 'ls'",
    "bash --version",
    "bash -n s.sh",
    "eval 'ls'",
    "./build.sh",
    "python3 s.py",
    "script -qc 'ls' /dev/null",
    "script --version",
  ])("%s is not opaque", (command) => {
    expect(opaque(command)).toBe(false);
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
    // #62 M7: more wrappers, their values and positionals, and env -S.
    [
      ["flock", "-w", "5", "/tmp/l", "curl", "-s"],
      ["curl", "-s"],
    ],
    [["setsid", "-f", "curl"], ["curl"]],
    [
      ["taskset", "-c", "1", "curl", "-X"],
      ["curl", "-X"],
    ],
    [["chrt", "-f", "1", "curl"], ["curl"]],
    [["exec", "-a", "name", "curl"], ["curl"]],
    [["coproc", "curl"], ["curl"]],
    [["npx", "--yes", "curl"], ["curl"]],
    [["npx", "-p", "pkg", "tool"], ["tool"]],
    [
      ["busybox", "wget", "u"],
      ["wget", "u"],
    ],
    [["timeout", "5", "-x"], ["-x"]],
    [
      ["env", "-S", "FOO=1 curl -d", "x"],
      ["curl", "-d", "x"],
    ],
    [["env", "-u", "S", "curl"], ["curl"]],
    [
      ["flock", "/tmp/l", "-c", "curl x"],
      ["flock", "/tmp/l", "-c", "curl x"],
    ],
    [
      ["npx", "-c", "curl x"],
      ["npx", "-c", "curl x"],
    ],
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
