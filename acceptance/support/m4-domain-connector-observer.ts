// Host-only observation of actual Gateway method invocations. Run-token ledger submissions
// cannot append to this closure, manufacture its opaque handle, or rewrite captured results.
import type { RunEvent, RunId } from "@deskmates/contracts";
import type { GatewayContext } from "@deskmates/gateway";
import { domainErrorKind } from "./m4-domain-finalize.js";

type Operation = "describe" | "validate" | "submit" | "status" | "receipt";
type Proxy = Pick<GatewayContext["connectorProxy"], Operation>;
declare const traceBrand: unique symbol;
export interface DataConnectorTrace {
  readonly [traceBrand]: true;
}
interface TraceState {
  entries: RunEvent[];
  sealed: boolean;
  sealSequence: number | null;
  pendingSubmissionsAtSeal: unknown[];
}
const traces = new WeakMap<DataConnectorTrace, TraceState>();

export function dataConnectorObservationReceipt(trace: DataConnectorTrace): TraceState {
  const state = traces.get(trace);
  if (!state) throw Error("data provenance requires a live host-owned connector trace");
  return structuredClone(state);
}

export function dataConnectorObservations(trace: DataConnectorTrace): RunEvent[] {
  return dataConnectorObservationReceipt(trace).entries;
}

export function requireSettledDataSubmissions(trace: DataConnectorTrace): void {
  const state = dataConnectorObservationReceipt(trace);
  if (!state.sealed) throw Error("data connector trace must be sealed before verification");
  if (state.pendingSubmissionsAtSeal.length)
    throw Error(
      "data submit outcome is failed or unresolved at seal; remote execution may be unknown",
    );
  const entries = state.entries;
  for (const call of entries.filter(
    (entry) => entry.kind === "tool_call" && entry.payload.operation === "submit",
  )) {
    const results = entries.filter(
      (entry) =>
        entry.kind === "tool_result" && entry.payload.observationId === call.payload.observationId,
    );
    if (results.length !== 1 || results[0]?.payload.isError !== false)
      throw Error("data submit outcome is failed or unresolved; remote execution may be unknown");
  }
}

export function observeDataConnector(
  proxy: Proxy,
  owner: { botId: string; connectorId: string; connectorName: string },
): { trace: DataConnectorTrace; seal(): void; restore(): void } {
  const trace = Object.freeze({}) as DataConnectorTrace;
  const entries: RunEvent[] = [];
  const state: TraceState = {
    entries,
    sealed: false,
    sealSequence: null,
    pendingSubmissionsAtSeal: [],
  };
  traces.set(trace, state);
  let sequence = 0;
  let observation = 0;
  const append = (runId: RunId, kind: RunEvent["kind"], payload: Record<string, unknown>) => {
    entries.push(
      structuredClone({ runId, kind, payload, seq: ++sequence, ts: new Date().toISOString() }),
    );
  };
  function wrap<Tail extends unknown[], Result>(
    operation: Operation,
    method: (runId: RunId, ref: string, ...args: Tail) => Promise<Result>,
    inputIds: (args: Tail) => Record<string, unknown>,
    resultIds: (result: Result) => Record<string, unknown>,
  ) {
    return async (runId: RunId, ref: string, ...args: Tail): Promise<Result> => {
      const base = {
        source: "connector_proxy",
        operation,
        observationId: ++observation,
        botId: owner.botId,
        connectorId:
          ref === owner.connectorName || ref === owner.connectorId ? owner.connectorId : ref,
        connectorRef: ref,
        ...inputIds(args),
      };
      // Record before invoking the method, including calls that throw synchronously or hang.
      append(runId, "tool_call", base);
      let forwarded = false;
      try {
        if (state.sealed) throw Error("data connector observer is sealed; call was not forwarded");
        forwarded = true;
        const result = await method.call(proxy, runId, ref, ...args);
        append(runId, "tool_result", {
          ...base,
          ...resultIds(result),
          isError: false,
          forwarded,
          result,
        });
        return result;
      } catch (error) {
        append(runId, "tool_result", {
          ...base,
          isError: true,
          forwarded,
          error: domainErrorKind(error),
        });
        throw error;
      }
    };
  }
  const originals = {
    describe: proxy.describe,
    validate: proxy.validate,
    submit: proxy.submit,
    status: proxy.status,
    receipt: proxy.receipt,
  };
  proxy.describe = wrap(
    "describe",
    originals.describe,
    () => ({}),
    () => ({}),
  );
  proxy.validate = wrap(
    "validate",
    originals.validate,
    () => ({}),
    (result) => ({
      validationId: result.validationId,
      contentHash: result.contentHash,
      valid: result.valid,
      effect: result.effect,
    }),
  );
  proxy.submit = wrap(
    "submit",
    originals.submit,
    ([input]) => ({
      validationId: input.validationId,
      contentHash: input.contentHash,
      idempotencyKey: input.idempotencyKey || input.validationId,
    }),
    (result) => ({ receiptId: result.receipt.receiptId, duplicate: result.duplicate }),
  );
  const receiptIds = (result: Awaited<ReturnType<Proxy["receipt"]>>) => ({
    validationId: result.validationId,
    contentHash: result.contentHash,
    status: result.current.status,
  });
  proxy.status = wrap("status", originals.status, ([receiptId]) => ({ receiptId }), receiptIds);
  proxy.receipt = wrap("receipt", originals.receipt, ([receiptId]) => ({ receiptId }), receiptIds);
  return {
    trace,
    seal() {
      if (state.sealed) return;
      state.sealed = true;
      state.sealSequence = sequence;
      state.pendingSubmissionsAtSeal = entries
        .filter(
          (entry) =>
            entry.kind === "tool_call" &&
            entry.payload.operation === "submit" &&
            !entries.some(
              (result) =>
                result.kind === "tool_result" &&
                result.payload.observationId === entry.payload.observationId,
            ),
        )
        .map((entry) => entry.payload.observationId);
    },
    restore() {
      if (state.sealed) throw Error("a sealed data observer cannot be restored");
      Object.assign(proxy, originals);
    },
  };
}
