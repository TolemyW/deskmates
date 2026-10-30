// A small POSIX-shell tokeniser for classifying `Bash` tool commands (risk-tier.ts) and finding
// shell fetches (tool-action.ts). It does not execute or expand anything: variables, globs and
// aliases are left as written, so a command whose meaning is only known at run time
// (`$(which curl) ...`, `$FETCH ...`) must be treated by callers as unknown, not as harmless;
// `isOpaqueCommand` and `hasExpandedCommandWord` name those commands.
//
// The rules honoured: single quotes (literal), double quotes (backslash escapes `"`, `\`, `$`,
// backtick), backslash escapes outside quotes, `#` comments at a word start, the list and
// pipeline operators `|`, `||`, `&`, `&&`, `;`, newline, subshell parentheses, and the command
// substitutions `$(...)` and backtick, whose bodies become segments of their own so the commands
// inside them are classified like any other.

const SEGMENT_BREAK = new Set(["|", "&", ";", "\n", "(", ")"]);

/** Wrapper commands that run their last arguments as a command of their own. */
const WRAPPERS = new Set([
  "env",
  "command",
  "exec",
  "xargs",
  "nice",
  "timeout",
  "sudo",
  "nohup",
  "time",
  "builtin",
  "stdbuf",
  "ionice",
  // #62 M7: these run their remaining words as a command too.
  "setsid",
  "flock",
  "taskset",
  "chrt",
  "busybox",
  "npx",
]);

/** Wrapper options that take a separate value: skip the value as well. */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  exec: new Set(["-a"]),
  sudo: new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-T", "-U", "-D"]),
  nice: new Set(["-n"]),
  xargs: new Set(["-n", "-L", "-P", "-I", "-d", "-a", "-s", "-E"]),
  timeout: new Set(["-s", "-k"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n", "-p"]),
  flock: new Set(["-w", "-E", "--wait", "--timeout", "--conflict-exit-code"]),
  chrt: new Set(["-T", "-P", "-D", "--sched-runtime", "--sched-period", "--sched-deadline"]),
  npx: new Set(["-p", "--package"]),
};

/**
 * Wrappers whose first positional words are not the command: the duration for `timeout`, the
 * lock file for `flock`, the CPU mask for `taskset`, the priority for `chrt`.
 */
const WRAPPER_POSITIONALS: Readonly<Record<string, number>> = {
  timeout: 1,
  flock: 1,
  taskset: 1,
  chrt: 1,
};

/** Shell reserved words that can precede a command without changing what it runs. */
const KEYWORDS = new Set([
  "{",
  "}",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "time",
  "coproc",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Index just past the `)` that closes a `$(` opened at `open` (the index of `$`). */
function closeOfSubstitution(text: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "$" && text[i + 1] === "(") {
        i = closeOfSubstitution(text, i) - 1;
      }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Index just past the backtick that closes one opened at `open`. */
function closeOfBacktick(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") return i + 1;
  }
  return text.length;
}

/**
 * Split a command line into its simple-command segments: the text between unquoted `|`, `||`,
 * `&`, `&&`, `;`, newlines and subshell parentheses. The body of every `$(...)` and backtick
 * substitution is appended as a segment of its own (recursively), after the segment that
 * contains it. Segments are trimmed; empty ones are dropped.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  const nested: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let atWordStart = true;

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed !== "") segments.push(trimmed);
    current = "";
    atWordStart = true;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (quote === "'") {
      current += c;
      if (c === "'") quote = undefined;
      continue;
    }
    if (c === "\\") {
      current += c + (command[i + 1] ?? "");
      i++;
      atWordStart = false;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      const end = closeOfSubstitution(command, i);
      current += command.slice(i, end);
      nested.push(command.slice(i + 2, end - 1));
      i = end - 1;
      atWordStart = false;
      continue;
    }
    if (c === "`") {
      // Backticks substitute inside double quotes as well.
      const end = closeOfBacktick(command, i);
      current += command.slice(i, end);
      nested.push(command.slice(i + 1, command[end - 1] === "`" ? end - 1 : end));
      i = end - 1;
      atWordStart = false;
      continue;
    }
    if (quote === '"') {
      current += c;
      if (c === '"') quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      atWordStart = false;
      continue;
    }
    if (c === "#" && atWordStart) {
      // Comment to end of line.
      const nl = command.indexOf("\n", i);
      i = nl === -1 ? command.length : nl - 1;
      continue;
    }
    if (c === "&" && (current.endsWith(">") || current.endsWith("<"))) {
      // `2>&1`, `<&0`: a redirection, not a list operator.
      current += c;
      atWordStart = false;
      continue;
    }
    if (c === "&" && command[i + 1] === ">") {
      // `&>` redirects both streams.
      current += c;
      atWordStart = false;
      continue;
    }
    if (SEGMENT_BREAK.has(c)) {
      flush();
      continue;
    }
    if (c === " " || c === "\t") {
      current += c;
      atWordStart = true;
      continue;
    }
    current += c;
    atWordStart = false;
  }
  flush();

  for (const body of nested) segments.push(...splitShellSegments(body));
  return segments;
}

/**
 * Split one segment into argv words: whitespace separates, single quotes are literal, double
 * quotes and backslashes escape. Substitutions stay as written inside their word.
 */
export function splitShellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] ?? "";
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else current += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && ['"', "\\", "$", "`"].includes(segment[i + 1] ?? "")) {
        current += segment[i + 1];
        i++;
      } else if (c === "$" && segment[i + 1] === "(") {
        const end = closeOfSubstitution(segment, i);
        current += segment.slice(i, end);
        i = end - 1;
      } else current += c;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < segment.length) {
        current += segment[i + 1];
        i++;
      }
      inWord = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "$" && segment[i + 1] === "(") {
      const end = closeOfSubstitution(segment, i);
      current += segment.slice(i, end);
      i = end - 1;
      inWord = true;
      continue;
    }
    if (c === "`") {
      const end = closeOfBacktick(segment, i);
      current += segment.slice(i, end);
      i = end - 1;
      inWord = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    current += c;
    inWord = true;
  }
  if (inWord) words.push(current);
  return words;
}

/** The last path component of a command word: `/usr/bin/curl` -> `curl`. */
export function basename(word: string): string {
  const i = word.lastIndexOf("/");
  return i === -1 ? word : word.slice(i + 1);
}

/**
 * Drop leading variable assignments (`FOO=bar`), reserved words and wrapper commands (`env`,
 * `sudo`, `timeout 5`, ...) with their options, so the first remaining word is the command that
 * actually runs. Callers that treat a wrapper itself as significant (`sudo` is L2) inspect the
 * raw argv first.
 */
export function unwrapArgv(argv: readonly string[]): string[] {
  let i = 0;
  for (;;) {
    const word = argv[i];
    if (word === undefined) return [];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || KEYWORDS.has(word)) {
      i++;
      continue;
    }
    const name = basename(word);
    if (!WRAPPERS.has(name)) return argv.slice(i);
    const start = i;
    i++;
    const valueOptions = WRAPPER_VALUE_OPTIONS[name];
    let positionals = WRAPPER_POSITIONALS[name] ?? 0;
    // `env FOO=1 cmd`, `sudo -u root cmd`, `timeout -k 2 5 cmd`.
    while (i < argv.length) {
      const w = argv[i] ?? "";
      if (w === "--") {
        i++;
        break;
      }
      if (w.startsWith("-")) {
        const split = name === "env" ? envSplitString(argv, i) : undefined;
        // `env -S '<words>' args` (#62 M7): env splits the value into the command's first words.
        if (split !== undefined)
          return unwrapArgv([...splitShellWords(split.value), ...argv.slice(split.next)]);
        // `npx -c '<line>'` runs a command line, not its words: npx stays the command.
        if (name === "npx" && /^(-c|--call)(=|$)/.test(w)) return argv.slice(start);
        i++;
        if (valueOptions?.has(w)) i++;
        continue;
      }
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        i++;
        continue;
      }
      if (positionals > 0) {
        positionals--;
        i++;
        // The command follows the last positional; a later `-x` is the command's own.
        if (positionals === 0) break;
        continue;
      }
      break;
    }
    // `flock <file> -c '<line>'` runs a command line: flock stays the command.
    if (name === "flock" && (argv[i] === "-c" || argv[i] === "--command")) return argv.slice(start);
  }
}

/**
 * The value of `env -S` in the option word `argv[i]` (`-S<v>`, `-S <v>`, `-iS <v>`,
 * `--split-string=<v>`, `--split-string <v>`) and the index just past it, or undefined when that
 * word is another option.
 */
function envSplitString(
  argv: readonly string[],
  i: number,
): { value: string; next: number } | undefined {
  const w = argv[i] ?? "";
  if (w.startsWith("--")) {
    const [name, attached] = w.split(/=(.*)/s, 2) as [string, string | undefined];
    if (name !== "--split-string") return undefined;
    return attached !== undefined
      ? { value: attached, next: i + 1 }
      : { value: argv[i + 1] ?? "", next: i + 2 };
  }
  for (let j = 1; j < w.length; j++) {
    const flag = w[j];
    // `-u` and `-C` take the rest of the word (or the next word) as their value.
    if (flag === "u" || flag === "C") return undefined;
    if (flag === "S") {
      const rest = w.slice(j + 1);
      return rest !== "" ? { value: rest, next: i + 1 } : { value: argv[i + 1] ?? "", next: i + 2 };
    }
  }
  return undefined;
}

/** `script` options that take a value (util-linux): skip it when looking for `-c`. */
const SCRIPT_VALUE_FLAGS = new Set(["B", "I", "O", "T", "m", "o", "E"]);
const SCRIPT_VALUE_LONG_OPTIONS = new Set([
  "--log-io",
  "--log-in",
  "--log-out",
  "--log-timing",
  "--logging-format",
  "--output-limit",
  "--echo",
]);

/**
 * The command line a program runs with a shell from one of its option values (#62 M7):
 * `script -c` (`-qc`, `-c<line>`, `--command`), `flock <file> -c` and `npx -c` (`--call`), or
 * undefined when it names none. `args` are the words after the program's name.
 */
function commandLineOption(name: string, args: readonly string[]): string | undefined {
  if (name === "script") {
    for (let i = 0; i < args.length; i++) {
      const w = args[i] ?? "";
      if (w === "--") return undefined;
      if (w.startsWith("--")) {
        const [long, attached] = w.split(/=(.*)/s, 2) as [string, string | undefined];
        if (long === "--command") return attached ?? args[i + 1];
        if (attached === undefined && SCRIPT_VALUE_LONG_OPTIONS.has(long)) i++;
        continue;
      }
      if (!w.startsWith("-")) continue;
      for (let j = 1; j < w.length; j++) {
        const flag = w[j] ?? "";
        const rest = w.slice(j + 1);
        if (flag === "c") return rest !== "" ? rest : args[i + 1];
        // `-t[file]` takes only an attached value.
        if (flag === "t") break;
        if (SCRIPT_VALUE_FLAGS.has(flag)) {
          if (rest === "") i++;
          break;
        }
      }
    }
    return undefined;
  }
  if (name === "flock") {
    // `unwrapArgv` keeps flock as the command only when `-c` follows its lock file.
    let i = 0;
    for (; i < args.length && (args[i] ?? "").startsWith("-"); i++)
      if (WRAPPER_VALUE_OPTIONS.flock?.has(args[i] ?? "")) i++;
    const option = args[i + 1];
    return option === "-c" || option === "--command" ? args[i + 2] : undefined;
  }
  if (name === "npx") {
    for (let i = 0; i < args.length; i++) {
      const w = args[i] ?? "";
      if (!w.startsWith("-")) return undefined;
      const [long, attached] = w.split(/=(.*)/s, 2) as [string, string | undefined];
      if (long === "-c" || long === "--call") return attached ?? args[i + 1];
      if (attached === undefined && WRAPPER_VALUE_OPTIONS.npx?.has(long)) i++;
    }
  }
  return undefined;
}

/** `script` options that only report, so it runs nothing. */
const SCRIPT_INFO_OPTIONS = new Set(["-V", "--version", "-h", "--help"]);

/** `watch` options that take a separate value. */
const WATCH_VALUE_OPTIONS = new Set(["-n", "--interval"]);

/**
 * The command line `watch` runs: its words after the options, joined and handed to `sh -c`
 * (`watch 'curl …'`, `watch -n 1 curl …`). With `-x`/`--exec` the words are an argv instead,
 * which `shellArgvs` reads as written.
 */
function watchCommandLine(args: readonly string[]): string | undefined {
  let i = 0;
  for (; i < args.length; i++) {
    const w = args[i] ?? "";
    if (w === "--") {
      i++;
      break;
    }
    if (!w.startsWith("-")) break;
    if (w === "-x" || w === "--exec") return undefined;
    if (WATCH_VALUE_OPTIONS.has(w)) i++;
  }
  return i < args.length ? args.slice(i).join(" ") : undefined;
}

/** Shell long options that take the next word as their value. */
const SHELL_VALUE_LONG_OPTIONS = new Set(["--rcfile", "--init-file"]);

/** Shell options that only report, so the shell runs nothing. */
const SHELL_INFO_OPTIONS = new Set(["--version", "--help"]);

type ShellInvocation =
  /** `-c` in any short-option cluster (`-c`, `-lc`, `-ec`, `-xc`): the script that runs. */
  | { kind: "script"; script: string }
  /** A script file, stdin (`... | sh`, `sh -s`) or a here-document: what runs is not readable. */
  | { kind: "opaque" }
  /** `--version`, `--help`, `-n` (read without executing), or `-c` with no script. */
  | { kind: "none" };

/**
 * What a shell invocation runs, from its arguments after the shell's name. Options come first;
 * `-c` may sit in any cluster of short options and its script is the first word after the
 * options, as bash, dash and zsh read it.
 */
function shellInvocation(args: readonly string[]): ShellInvocation {
  let script = false;
  let runsNothing = false;
  let i = 0;
  for (; i < args.length; i++) {
    const w = args[i] ?? "";
    if (w === "--" || w === "-") {
      i++;
      break;
    }
    if (w.startsWith("--")) {
      if (SHELL_INFO_OPTIONS.has(w)) runsNothing = true;
      if (SHELL_VALUE_LONG_OPTIONS.has(w)) i++;
      continue;
    }
    if (!/^[-+][A-Za-z]+$/.test(w)) break;
    const flags = w.slice(1);
    if (w.startsWith("-") && flags.includes("c")) script = true;
    if (w.startsWith("-") && flags.includes("n")) runsNothing = true;
    // `-o pipefail`, `+O extglob`: each o or O in the cluster takes one word.
    i += (flags.match(/[oO]/g) ?? []).length;
  }
  const operand = args[i];
  if (script) return operand === undefined ? { kind: "none" } : { kind: "script", script: operand };
  return runsNothing ? { kind: "none" } : { kind: "opaque" };
}

/** Builtins that run a file in the current shell. */
const SOURCERS = new Set(["source", "."]);

/**
 * Whether one simple command's program is a word expanded at run time (`$c`, `${c}`, `$(...)`,
 * a backtick), so even which program runs cannot be read. A `$` in an argument does not count:
 * `echo $HOME` runs echo. `eval` is not expanded by itself: `shellArgvs` tokenises its words like
 * a `-c` script, and an expanded command word inside it is caught here.
 */
export function hasExpandedCommandWord(argv: readonly string[]): boolean {
  const head = unwrapArgv(argv)[0];
  return head !== undefined && /[$`]/.test(head);
}

/**
 * Whether one simple command (an argv from `shellArgvs`) runs something its words do not name,
 * so no classifier can read what it does: an expanded command word (`hasExpandedCommandWord`),
 * a shell that runs a script file or reads stdin (`bash s.sh`, `... | sh`, a here-document), or
 * `source` / `.`. The risk tier rates these L2; only the expanded command word also counts as a
 * shell fetch for egress, since a script file names a program, just not what it does.
 */
export function isOpaqueCommand(argv: readonly string[]): boolean {
  if (hasExpandedCommandWord(argv)) return true;
  const cmd = unwrapArgv(argv);
  if (cmd[0] === undefined) return false;
  const name = basename(cmd[0]);
  if (SOURCERS.has(name)) return true;
  // `script` with no `-c` runs an interactive shell that reads stdin, like `… | sh` (#62 M7).
  if (name === "script") {
    const args = cmd.slice(1);
    return (
      commandLineOption(name, args) === undefined && !args.some((w) => SCRIPT_INFO_OPTIONS.has(w))
    );
  }
  return SHELLS.has(name) && shellInvocation(cmd.slice(1)).kind === "opaque";
}

/** Whether `tail` is the last `tail.length` words of `argv`. */
function isTailOf(tail: readonly string[], argv: readonly string[]): boolean {
  const offset = argv.length - tail.length;
  return offset >= 0 && tail.every((w, k) => argv[offset + k] === w);
}

/**
 * Every segment of the command as argv words. A script handed to `sh -c` (or bash, zsh, dash,
 * ksh, with `-c` in any option cluster such as `-lc`) is tokenised too, and so are the words of
 * `eval` and of `watch`, and the command line of `script -c`, `flock <file> -c` and `npx -c`;
 * their segments follow the one that invoked them. The words `env -S` splits its value into are
 * an argv of their own, after the one that invoked it (#62 M7).
 */
export function shellArgvs(command: string): string[][] {
  const out: string[][] = [];
  for (const segment of splitShellSegments(command)) {
    const argv = splitShellWords(segment);
    if (argv.length === 0) continue;
    out.push(argv);
    const cmd = unwrapArgv(argv);
    // Only `env -S` makes the command something other than the argv's last words.
    if (cmd.length > 0 && !isTailOf(cmd, argv)) out.push(cmd);
    const name = cmd[0] === undefined ? "" : basename(cmd[0]);
    const args = cmd.slice(1);
    if (SHELLS.has(name)) {
      const run = shellInvocation(args);
      if (run.kind === "script") out.push(...shellArgvs(run.script));
    } else if (name === "eval" && cmd.length > 1) {
      out.push(...shellArgvs(args.join(" ")));
    } else if (name === "watch") {
      const line = watchCommandLine(args);
      if (line !== undefined) out.push(...shellArgvs(line));
    } else {
      const line = commandLineOption(name, args);
      if (line !== undefined) out.push(...shellArgvs(line));
    }
  }
  return out;
}
