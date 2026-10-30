// Deterministic text helpers shared by the retrieval and cheap-model task sets (protocol of
// 2026-10-17): the token rule FTS5 uses, answer normalisation for exact-match oracles, a seeded
// generator and the `filler-v1` text the large variants and the background corpus are built from.
// Nothing here calls a model or reads the clock; the same input gives the same output everywhere.

/** The Gateway's FTS5 query tokens (`ftsMatch`, `memoryQueryTokens`): letters, digits, `_`. */
export function tokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  ).map((t) => t);
}

/**
 * Words a question shares with almost any text. A shared stop word does not make a question
 * lexical: under `bm25` with an OR query it ranks nothing in particular.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an the of to in on at by for from with and or not no is are was were be been being it its " +
    "this that these those there their our we you your i me my he she they them do does did done " +
    "can could may might must should would will shall what which who whom whose when where why how " +
    "if then than so as into onto out over under up down off about after before each every some " +
    "any all one two per own also only just more most less such has have had"
  ).split(" "),
);

/** Content tokens: tokens that are not stop words. */
export function contentTokens(text: string): Set<string> {
  return new Set(tokens(text).filter((t) => !STOP_WORDS.has(t)));
}

/**
 * Exact-match normalisation (benchmark §5, extended): NFKC, lower case, surrounding quotes,
 * backticks and Markdown emphasis and a trailing full stop removed, whitespace collapsed, thousands separators removed
 * from digit groups.
 */
export function normalizeAnswer(value: string): string {
  let s = value.normalize("NFKC").trim().toLowerCase();
  for (let i = 0; i < 2; i += 1) {
    s = s.replace(/^[`'"“”‘’*_]+|[`'"“”‘’*_]+$/g, "").trim();
    s = s.replace(/[.。]+$/u, "").trim();
  }
  s = s.replace(/\s+/g, " ");
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  return s;
}

/** Benchmark §5: the answer is the value of the last `answer: <value>` line of the final reply. */
export function answerOf(reply: string | undefined): string | undefined {
  if (reply === undefined) return undefined;
  const lines = reply.replace(/\r\n?/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^\s*[*_`]*answer[*_`]*\s*[:：]\s*(.*?)\s*$/i.exec(lines[i] ?? "");
    if (match) return (match[1] ?? "").replace(/[*_`]+$/, "").trim();
  }
  return undefined;
}

/** True when `needle`, normalised, occurs in `haystack` as a run of whole tokens. */
export function containsTokens(haystack: string, needle: string): boolean {
  const n = tokens(needle);
  if (n.length === 0) return false;
  const h = tokens(haystack);
  for (let i = 0; i + n.length <= h.length; i += 1) {
    if (n.every((t, j) => h[i + j] === t)) return true;
  }
  // CJK runs are one token under unicode61, so a CJK needle is matched as a substring too.
  return /[\p{Script=Han}]/u.test(needle) && haystack.includes(needle.trim());
}

/** Case-insensitive substring test after NFKC, for oracles written as phrases. */
export function includesPhrase(haystack: string, phrase: string): boolean {
  return haystack.normalize("NFKC").toLowerCase().includes(phrase.normalize("NFKC").toLowerCase());
}

/** mulberry32: a small seeded generator, enough for reproducible filler. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, list: readonly T[]): T {
  return list[Math.floor(next() * list.length)] as T;
}

// filler-v1 word lists. They avoid every name, code, colour, weekday and number the task sets
// ask about; `retrieval-eval.test.ts` and `cheap-model-eval.test.ts` check that they still do.
const ROOMS = [
  "Altair",
  "Bellatrix",
  "Capella",
  "Deneb",
  "Electra",
  "Fomalhaut",
  "Gacrux",
  "Hadar",
  "Izar",
  "Jabbah",
  "Keid",
  "Lesath",
  "Mirach",
  "Nashira",
  "Okab",
  "Phact",
  "Rigel",
  "Sabik",
  "Tarazed",
  "Unuk",
  "Wezen",
  "Zaniah",
] as const;
const DEVICES = [
  "projector",
  "whiteboard",
  "speakerphone",
  "wall screen",
  "document camera",
  "flip chart",
] as const;
const TEAMS = [
  "The packing team",
  "The returns team",
  "The front office",
  "The cleaning crew",
  "The facilities team",
  "The training group",
  "The canteen staff",
  "The reception team",
] as const;
const THINGS = [
  "spare scanners",
  "tape guns",
  "bubble wrap",
  "visitor lanyards",
  "box cutters",
  "label rolls",
  "hand trucks",
  "safety vests",
  "packing peanuts",
  "clipboards",
] as const;
const PLACES = [
  "the blue cupboard",
  "the mezzanine shelf",
  "the corner locker",
  "the training room",
  "the canteen store",
  "the reception drawer",
  "the east stairwell cabinet",
] as const;
const HABITS = [
  "prefers matte labels for gift orders",
  "keeps the radio off before noon",
  "orders sandwiches on payday",
  "stacks empty crates by the side door",
  "files timesheets on the last working day",
  "waters the office plants on Wednesdays",
  "uses the north entrance during deliveries",
  "books the training room a week ahead",
] as const;
/** Numbers filler may use: none of them is an answer, a code fragment or an alias. */
const FILLER_NUMBERS = [3, 4, 5, 6, 8, 11, 13, 16, 17, 18, 21, 23, 26, 27, 29, 31, 33, 37] as const;

export interface FillerDoc {
  id: string;
  title: string;
  body: string;
}

const WINGS = ["North", "South", "East", "West", "Upper", "Lower"] as const;

/** A seeded Fisher-Yates shuffle of a copy of `list`. */
function shuffled<T>(list: readonly T[], next: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** `count` filler Knowledge documents (at most 132): meeting rooms, deterministic for a seed. */
export function fillerKnowledge(count: number, seed: number): FillerDoc[] {
  const next = seeded(seed);
  const names = shuffled(
    ROOMS.flatMap((room) => WINGS.map((wing) => `${room} ${wing}`)),
    next,
  ).slice(0, count);
  if (names.length < count) throw new Error(`filler-v1 has ${names.length} rooms, ${count} asked`);
  return names.map((name, i) => ({
    id: `KF${String(i + 1).padStart(3, "0")}`,
    title: `Meeting room ${name}`,
    body: `Meeting room ${name} is on floor ${pick(next, FILLER_NUMBERS)}, seats ${pick(next, FILLER_NUMBERS)} people and has a ${pick(next, DEVICES)}.`,
  }));
}

/** Every distinct filler sentence, in a fixed order. */
export const FILLER_SENTENCES: readonly string[] = [
  ...TEAMS.flatMap((team) =>
    THINGS.flatMap((thing) => PLACES.map((place) => `${team} keeps ${thing} in ${place}.`)),
  ),
  ...TEAMS.flatMap((team) => HABITS.map((habit) => `${team} ${habit}.`)),
];

/**
 * `count` distinct filler memory notes (at most 624): one line each, so each costs one line of
 * the pinned index.
 */
export function fillerNotes(count: number, seed: number): { id: string; body: string }[] {
  const bodies = shuffled(FILLER_SENTENCES, seeded(seed ^ 0x5bd1e995)).slice(0, count);
  if (bodies.length < count)
    throw new Error(`filler-v1 has ${bodies.length} notes, ${count} asked`);
  return bodies.map((body, i) => ({ id: `MF${String(i + 1).padStart(3, "0")}`, body }));
}

/** Filler sentences until `chars` characters are reached, never cutting a sentence. */
export function fillerParagraph(chars: number, seed: number): string {
  const next = seeded(seed ^ 0x27d4eb2d);
  const parts: string[] = [];
  let length = 0;
  while (length < chars) {
    const sentence = pick(next, FILLER_SENTENCES);
    if (length + sentence.length + 1 > chars && parts.length > 0) break;
    parts.push(sentence);
    length += sentence.length + 1;
  }
  return parts.join(" ");
}

/** Filler roster members for large triage cases: roles with nothing to do with any request. */
export const FILLER_MEMBERS: readonly { name: string; role: string }[] = [
  { name: "plants", role: "waters the office plants" },
  { name: "canteen", role: "plans the canteen menu" },
  { name: "parking", role: "assigns parking spaces" },
  { name: "lockers", role: "hands out locker keys" },
  { name: "trainer", role: "runs fire drill training" },
  { name: "events", role: "plans the summer party" },
];
