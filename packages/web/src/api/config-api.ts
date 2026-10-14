// Gateway-wide operator configuration (model defaults, release) that no single feature owns: the
// app shell, bot profile and bot management all read it.

import type { OperatorConfig } from "@deskmates/contracts";
import type { HttpTransport } from "../platform/http-transport.js";

export interface ConfigApi {
  getConfig(): Promise<OperatorConfig>;
}

export function createConfigApi(t: HttpTransport): ConfigApi {
  return {
    getConfig() {
      return t.json("GET", "/api/config");
    },
  };
}
