// A small POSIX-shell tokeniser for classifying `Bash` tool commands (risk-tier.ts) and finding
// shell fetches (tool-action.ts). It does not execute or expand anything: variables, globs and
// aliases are left as written, so a command whose meaning is only known at run time
// (`$(which curl) ...`, `$FETCH ...`) must be treated by callers as unknown, not as harmless.
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
]);

/** Wrapper options that take a separate value: skip the value as well. */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "-C", "-S"]),
  sudo: new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-T", "-U", "-D"]),
  nice: new Set(["-n"]),
  xargs: new Set(["-n", "-L", "-P", "-I", "-d", "-a", "-s", "-E"]),
  timeout: new Set(["-s", "-k"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n", "-p"]),
};

/** Wrappers whose first positional word is not the command (the duration for `timeout`). */
const WRAPPER_POSITIONALS: Readonly<Record<string, number>> = { timeout: 1 };

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
        continue;
      }
      break;
    }
  }
}

/**
 * Every segment of the command as argv words. A script handed to `sh -c` (or bash, zsh, dash,
 * ksh) is tokenised too, and its segments follow the one that invoked the shell.
 */
export function shellArgvs(command: string): string[][] {
  const out: string[][] = [];
  for (const segment of splitShellSegments(command)) {
    const argv = splitShellWords(segment);
    if (argv.length === 0) continue;
    out.push(argv);
    const cmd = unwrapArgv(argv);
    if (cmd[0] !== undefined && SHELLS.has(basename(cmd[0]))) {
      const c = cmd.indexOf("-c");
      const script = c === -1 ? undefined : cmd[c + 1];
      if (script !== undefined) out.push(...shellArgvs(script));
    }
  }
  return out;
}
