export interface AbManifestInput {
  revision: string;
  workingTreeStatus: string;
  image: string;
  imageId: string;
  egressImage: string;
  egressImageId: string;
  modelA: string;
  modelB: string;
  rounds: number;
  defaultModel: string;
  endpointOrigin: string;
  /** Repo-relative path -> sha256 of the test and the support files that define the case. */
  fixtureSha256: Record<string, string>;
  startedAt: string;
}

export interface AbManifest {
  revision: string;
  workingTreeStatus: string;
  image: string;
  imageId: string;
  egressImage: string;
  egressImageId: string;
  rounds: number;
  roundOrder: "interleaved";
  arms: {
    A: { model: string; cheapModel: string };
    B: { model: string; cheapModel: string };
  };
  defaultModel: string;
  endpointOrigin: string;
  fixtureSha256: Record<string, string>;
  maxTurns: number;
  runTimeoutSeconds: number;
  browserSnapshotMode: "explicit-v1";
  startedAt: string;
}

/** Validate and shape manifest.json; throws on a missing model id, revision or image ID. */
export declare function buildAbManifest(input: AbManifestInput): AbManifest;
