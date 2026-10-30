// The X input record of desktop calls (ADR-0048 decision 4, option D; amendment 1, A5). The image
// names a reader of the display's XInput2 raw events (`xinput test-xi2`), which also carry
// the input XTEST synthesises (xdotool, the runtime's key presses, x11vnc). This module counts its
// raw key presses, button presses and motion events per open desktop call: counts only, never a
// key code or a coordinate, so typed text cannot reach the ledger. An event counts towards every
// call of this run open when it arrives. Under the exclusive lease (A3) that call is the only one
// open in the workspace, so its counts are its own input plus input from outside the lease; a
// focus-free call's counts should be zero. A record, never a refusal, and not a boundary.

/** What a call's window saw. */
export interface InputCounts {
  keys: number;
  buttons: number;
  motions: number;
  /** Another call of this run was open while it ran; the counts are shared with it. */
  overlapped: boolean;
}

/** The kind of raw event a reader line announces, or undefined for any other line. */
export function rawEventKind(line: string): "button" | "key" | "motion" | undefined {
  const match = /^EVENT type \d+ \(Raw(KeyPress|ButtonPress|Motion)\)/.exec(line.trim());
  if (!match) return undefined;
  return match[1] === "KeyPress" ? "key" : match[1] === "ButtonPress" ? "button" : "motion";
}

export class InputRecorder {
  private readonly open = new Map<string, InputCounts>();

  /** A call was dispatched: its window opens. */
  begin(key: string): void {
    const counts: InputCounts = { keys: 0, buttons: 0, motions: 0, overlapped: this.open.size > 0 };
    if (this.open.size > 0) for (const other of this.open.values()) other.overlapped = true;
    this.open.set(key, counts);
  }

  /** A call answered or was dropped: its window closes and its counts are returned. */
  end(key: string): InputCounts | undefined {
    const counts = this.open.get(key);
    this.open.delete(key);
    return counts;
  }

  /** One line of the reader's output. */
  line(line: string): void {
    const kind = rawEventKind(line);
    if (kind === undefined || this.open.size === 0) return;
    for (const counts of this.open.values()) {
      if (kind === "key") counts.keys += 1;
      else if (kind === "button") counts.buttons += 1;
      else counts.motions += 1;
    }
  }
}
