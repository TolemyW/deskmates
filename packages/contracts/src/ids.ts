// Branded string ids so a RunId cannot be passed where a BotId is expected.
// Branding is purely a compile-time device; at runtime these are plain strings.

declare const brand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Branded<string, "WorkspaceId">;
export type BotId = Branded<string, "BotId">;
export type ThreadId = Branded<string, "ThreadId">;
export type MessageId = Branded<string, "MessageId">;
export type RunId = Branded<string, "RunId">;
export type ApprovalId = Branded<string, "ApprovalId">;

/** ISO-8601 timestamp with timezone, as stored in SQLite text columns. */
export type IsoTimestamp = string;
