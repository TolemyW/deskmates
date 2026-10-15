/** Bounds of the CSV/TSV preview table (ADR-0014 amendment A6 decision 37). */
export const CSV_PREVIEW_MAX_ROWS = 200;
export const CSV_PREVIEW_MAX_COLUMNS = 50;

export interface CsvTable {
  header: string[];
  rows: string[][];
  /** Data records parsed from the decoded prefix, excluding the header. */
  totalRows: number;
  /** Widest record parsed from the decoded prefix. */
  totalColumns: number;
  moreRows: boolean;
  moreColumns: boolean;
}

/**
 * Parse RFC 4180 records: quoted fields, doubled quotes, and delimiters or line breaks inside
 * quotes. Cells stay plain strings; nothing is evaluated. When the bytes are a truncated prefix,
 * the last record may be cut and is dropped.
 */
export function parseDelimited(
  text: string,
  delimiter: string,
  truncated = false,
  maxRows = CSV_PREVIEW_MAX_ROWS,
  maxColumns = CSV_PREVIEW_MAX_COLUMNS,
): CsvTable {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let index = 0;
  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };
  while (index < text.length) {
    const character = text[index] as string;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
      } else field += character;
      index += 1;
      continue;
    }
    if (character === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (character === delimiter) endField();
    else if (character === "\r" && text[index + 1] === "\n") {
      endRecord();
      index += 1;
    } else if (character === "\n" || character === "\r") endRecord();
    else {
      field += character;
      fieldStarted = true;
    }
    index += 1;
  }
  // An unterminated last line is a record, unless the bytes are a cut prefix.
  if ((quoted || fieldStarted || field !== "" || record.length > 0) && !truncated) endRecord();
  const [header = [], ...data] = records;
  const totalColumns = records.reduce((widest, row) => Math.max(widest, row.length), 0);
  return {
    header: header.slice(0, maxColumns),
    rows: data.slice(0, maxRows).map((row) => row.slice(0, maxColumns)),
    totalRows: data.length,
    totalColumns,
    moreRows: data.length > maxRows || truncated,
    moreColumns: totalColumns > maxColumns,
  };
}
