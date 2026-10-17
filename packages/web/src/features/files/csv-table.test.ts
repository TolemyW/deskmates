import { describe, expect, it } from "vitest";
import { parseDelimited } from "./csv-table.js";

describe("parseDelimited (ADR-0014 A6 decision 37)", () => {
  it("keeps quoted delimiters, doubled quotes and quoted line breaks in one cell", () => {
    const table = parseDelimited(
      'name,note\r\n"Smith, Jo","said ""hi""\nthen left"\nplain,x\n',
      ",",
    );
    expect(table.header).toEqual(["name", "note"]);
    expect(table.rows).toEqual([
      ["Smith, Jo", 'said "hi"\nthen left'],
      ["plain", "x"],
    ]);
    expect(table.moreRows).toBe(false);
  });

  it("parses TSV and keeps an unterminated last line of a complete file", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t").rows).toEqual([["1", "2"]]);
  });

  it("drops the cut last record of a truncated prefix and marks more rows", () => {
    const table = parseDelimited('h1,h2\n1,2\n3,"partial', ",", true);
    expect(table.rows).toEqual([["1", "2"]]);
    expect(table.moreRows).toBe(true);
  });

  it("bounds rows and columns and reports what exists", () => {
    const wide = Array.from({ length: 60 }, (_, i) => `c${i}`).join(",");
    const body = [wide, ...Array.from({ length: 250 }, () => wide)].join("\n");
    const table = parseDelimited(body, ",");
    expect(table.header).toHaveLength(50);
    expect(table.rows).toHaveLength(200);
    expect(table.rows[0]).toHaveLength(50);
    expect(table.totalRows).toBe(250);
    expect(table.totalColumns).toBe(60);
    expect(table.moreRows).toBe(true);
    expect(table.moreColumns).toBe(true);
  });

  it("keeps a formula as text", () => {
    expect(parseDelimited('a\n=HYPERLINK("http://x")\n', ",").rows).toEqual([
      ['=HYPERLINK("http://x")'],
    ]);
  });
});
