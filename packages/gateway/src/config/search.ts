// Web search (ADR-0049 decision 2): installation configuration only. `SEARCH_URL` names a
// self-hosted SearXNG; without it no run is offered `web_search` and run rows are unchanged.
// `SEARCH_AUTH_TOKEN` is a Bearer for an instance behind an authenticating proxy; it stays in
// Gateway memory and never reaches a sandbox, a row or an error.

import { createHash } from "node:crypto";
import { DeskmatesError } from "@deskmates/contracts";
import { type Env, httpUrl } from "./env.js";

export interface SearchServiceConfig {
  /** The SearXNG search endpoint, `/search` included. */
  url: string;
  authToken?: string;
  /** sha256 of `url`, recorded instead of the address. */
  endpointSha256: string;
}

export interface SearchConfig {
  search?: SearchServiceConfig;
}

const PATH = "/search";

export function readSearchConfig(env: Env): SearchConfig {
  const raw = env.SEARCH_URL?.trim() ?? "";
  const token = env.SEARCH_AUTH_TOKEN?.trim() ?? "";
  if (raw === "") {
    if (token !== "")
      throw new DeskmatesError("validation", "SEARCH_AUTH_TOKEN is set without SEARCH_URL", {
        key: "SEARCH_AUTH_TOKEN",
      });
    return {};
  }
  const base = httpUrl("SEARCH_URL", raw);
  const url = base.endsWith(PATH) ? base : `${base}${PATH}`;
  return {
    search: {
      url,
      endpointSha256: createHash("sha256").update(url, "utf8").digest("hex"),
      ...(token === "" ? {} : { authToken: token }),
    },
  };
}
