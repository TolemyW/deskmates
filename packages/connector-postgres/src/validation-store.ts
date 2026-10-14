// Validations are kept in memory for the TTL (ADR-0012 item 5). A restart forgets them, which is
// safe: submit then refuses the id and the caller validates again; receipts are what survive.
// An expired entry is kept for one more TTL so that a late submit hears "stale" instead of
// "missing"; it is swept after that.

import type { ConnectorEffect, ConnectorFieldError } from "@deskmates/contracts";
import type { SqlBatch } from "./submission.js";

export interface StoredValidation {
  validationId: string;
  contentHash: string;
  valid: boolean;
  effect: ConnectorEffect;
  summary: string;
  errors: ConnectorFieldError[];
  /** Present when valid: exactly what submit executes. */
  batch?: SqlBatch;
}

export type ValidationLookup =
  | { status: "live"; validation: StoredValidation }
  | { status: "stale"; validation: StoredValidation }
  | { status: "missing" };

interface Entry {
  validation: StoredValidation;
  expiresAt: number;
}

export class ValidationStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;

  constructor(
    ttlSeconds: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.ttlMs = ttlSeconds * 1000;
  }

  put(validation: StoredValidation): void {
    this.sweep();
    this.entries.set(validation.validationId, {
      validation,
      expiresAt: this.clock() + this.ttlMs,
    });
  }

  lookup(validationId: string): ValidationLookup {
    const entry = this.entries.get(validationId);
    if (!entry) return { status: "missing" };
    if (this.clock() >= entry.expiresAt) return { status: "stale", validation: entry.validation };
    return { status: "live", validation: entry.validation };
  }

  private sweep(): void {
    const cutoff = this.clock() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= cutoff) this.entries.delete(id);
    }
  }
}
