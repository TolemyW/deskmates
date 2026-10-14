// The egress verdict table (ADR-0010 decision 3). Every enforcement point that matches a hostname
// against a workspace allowlist runs this same table: contracts `egressAllows` (which the
// sidecar's navigation, shell-fetch and workflow checks call) and the egress proxy's
// `hostnameAllowed`. A row that one of them answers differently is a hole in one layer.

export interface EgressVerdict {
  /** A hostname as the matcher receives it (URL `hostname`, so IPv6 arrives bracketed). */
  host: string;
  allowlist: readonly string[];
  allowed: boolean;
}

const OPEN = ["*"] as const;
const LISTED = ["golden.test", "*.example.com"] as const;

export const EGRESS_VERDICTS: readonly EgressVerdict[] = [
  // Deny by default.
  { host: "example.com", allowlist: [], allowed: false },
  // Exact and suffix entries.
  { host: "golden.test", allowlist: LISTED, allowed: true },
  { host: "Golden.Test", allowlist: LISTED, allowed: true },
  { host: "api.golden.test", allowlist: LISTED, allowed: false },
  { host: "example.com", allowlist: LISTED, allowed: true },
  { host: "a.b.example.com", allowlist: LISTED, allowed: true },
  { host: "notexample.com", allowlist: LISTED, allowed: false },
  { host: "127.0.0.1", allowlist: LISTED, allowed: false },
  // `*`: any public hostname.
  { host: "example.com", allowlist: OPEN, allowed: true },
  { host: "www.baidu.com", allowlist: OPEN, allowed: true },
  { host: "raw.githubusercontent.com", allowlist: OPEN, allowed: true },
  { host: "Mixed.Case.Example", allowlist: OPEN, allowed: true },
  { host: "example.com.", allowlist: OPEN, allowed: true },
  // `*` never admits an IP literal, in any spelling a URL parser or curl accepts.
  { host: "1.1.1.1", allowlist: OPEN, allowed: false },
  { host: "10.0.0.1", allowlist: OPEN, allowed: false },
  { host: "127.0.0.1", allowlist: OPEN, allowed: false },
  { host: "169.254.169.254", allowlist: OPEN, allowed: false },
  { host: "198.18.0.84", allowlist: OPEN, allowed: false },
  { host: "127.1", allowlist: OPEN, allowed: false },
  { host: "2130706433", allowlist: OPEN, allowed: false },
  { host: "0x7f000001", allowlist: OPEN, allowed: false },
  { host: "::1", allowlist: OPEN, allowed: false },
  { host: "[::1]", allowlist: OPEN, allowed: false },
  { host: "[2606:4700:4700::1111]", allowlist: OPEN, allowed: false },
  { host: "[::ffff:127.0.0.1]", allowlist: OPEN, allowed: false },
  // Nor a name that is loopback or the host by definition, nor something that is not a name.
  { host: "localhost", allowlist: OPEN, allowed: false },
  { host: "app.localhost", allowlist: OPEN, allowed: false },
  { host: "host.docker.internal", allowlist: OPEN, allowed: false },
  { host: "", allowlist: OPEN, allowed: false },
  { host: "has space.test", allowlist: OPEN, allowed: false },
];
