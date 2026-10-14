// What a demo route answers: a status with a JSON body or a blob, as the fetch shim in
// install.ts turns it into a Response.

export interface Result {
  status: number;
  json?: unknown;
  blob?: Blob;
}

export function ok(json: unknown): Result {
  return { status: 200, json };
}

export function created(json: unknown): Result {
  return { status: 201, json };
}

export function notFound(what: string): Result {
  return { status: 404, json: { code: "not_found", message: `${what} not found`, details: {} } };
}
