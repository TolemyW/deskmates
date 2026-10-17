// ADR-0041 decision 4: deterministic chunking, so a chunk's text can be recomputed from the
// current body instead of being stored. Changing these numbers means re-embedding: bump `version`.

export const CHUNKING = { version: 1, characters: 1200, overlap: 200 } as const;

/** Windows of at most `max` code points over one over-long paragraph, `overlap` shared. */
function windows(points: string[], max: number, overlap: number): string[] {
  const out: string[] = [];
  const step = Math.max(1, max - overlap);
  for (let start = 0; start < points.length; start += step) {
    out.push(points.slice(start, start + max).join(""));
    if (start + max >= points.length) break;
  }
  return out;
}

/**
 * Paragraphs (blank-line separated) packed greedily into chunks of at most `max` code points; a
 * paragraph longer than that becomes overlapping windows of its own. Blank text has no chunks.
 */
export function chunkText(
  text: string,
  max: number = CHUNKING.characters,
  overlap: number = CHUNKING.overlap,
): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentLength = 0;
  const flush = () => {
    if (current.trim()) chunks.push(current);
    current = "";
    currentLength = 0;
  };
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    if (!paragraph.trim()) continue;
    const points = Array.from(paragraph.trim());
    if (points.length > max) {
      flush();
      chunks.push(...windows(points, max, overlap));
      continue;
    }
    const joinCost = currentLength === 0 ? 0 : 2;
    if (currentLength + joinCost + points.length > max) flush();
    current = currentLength === 0 ? points.join("") : `${current}\n\n${points.join("")}`;
    currentLength += (currentLength === 0 ? 0 : 2) + points.length;
  }
  flush();
  return chunks;
}

/** What is embedded for a Knowledge chunk: the document title on its first line. */
export const knowledgeChunkInput = (title: string, chunk: string): string => `${title}\n${chunk}`;
