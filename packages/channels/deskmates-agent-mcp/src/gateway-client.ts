// The slice of the Gateway operator API the tools use, over plain fetch. The credential travels
// only in the Authorization header (ADR-0022 decision 4) and lives in a private field; every
// error message that leaves this module has it redacted, whatever the Gateway echoed back.

const REDACTED = "[redacted]";

/** A refusal or failure from the Gateway, or a transport failure before it answered. */
export class GatewayError extends Error {
  constructor(
    /** HTTP status; 0 when the Gateway could not be reached. */
    readonly status: number,
    /** The DeskmatesError code from the response body, or `gateway_unreachable` / `unknown`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export type Query = Readonly<Record<string, string | number | undefined>>;

export interface JsonResponse<T> {
  status: number;
  body: T;
}

export interface GatewayClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class GatewayClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Remove every occurrence of the credential from text bound for a log or a tool result. */
  redact(text: string): string {
    return this.#token ? text.split(this.#token).join(REDACTED) : text;
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    return (await this.json<T>("GET", path, { query })).body;
  }

  async post<T>(path: string, body?: unknown): Promise<JsonResponse<T>> {
    return this.json<T>("POST", path, { body: body ?? {} });
  }

  /** A raw download, e.g. the ADR-0014 file route. */
  async bytes(path: string, query?: Query): Promise<Uint8Array> {
    const response = await this.send("GET", path, { query, accept: "application/octet-stream" });
    if (!response.ok) throw await this.failure(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async json<T>(
    method: "GET" | "POST",
    path: string,
    options: { query?: Query | undefined; body?: unknown },
  ): Promise<JsonResponse<T>> {
    const response = await this.send(method, path, { ...options, accept: "application/json" });
    if (!response.ok) throw await this.failure(response);
    const text = await response.text();
    try {
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
    } catch {
      throw new GatewayError(response.status, "unknown", "the Gateway answered with invalid JSON");
    }
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    options: { query?: Query | undefined; body?: unknown; accept: string },
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    try {
      return await this.#fetch(url, {
        method,
        headers: {
          accept: options.accept,
          authorization: `Bearer ${this.#token}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (err) {
      const reason = err instanceof Error ? (causeMessage(err) ?? err.message) : String(err);
      throw new GatewayError(
        0,
        "gateway_unreachable",
        this.redact(`${method} ${path} could not reach the Gateway: ${reason}`),
      );
    }
  }

  private async failure(response: Response): Promise<GatewayError> {
    let parsed: { code?: unknown; message?: unknown } = {};
    try {
      parsed = JSON.parse(await response.text()) as typeof parsed;
    } catch {
      parsed = {};
    }
    const code = typeof parsed.code === "string" ? parsed.code : "unknown";
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : `the Gateway answered HTTP ${response.status}`;
    return new GatewayError(response.status, this.redact(code), this.redact(message));
  }
}

function causeMessage(err: Error): string | undefined {
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} (${cause.message})` : undefined;
}
