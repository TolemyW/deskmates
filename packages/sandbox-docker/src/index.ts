// @deskmates/sandbox-docker entry point: the Docker implementation of SandboxProvider.

import type { PrivateEgressTarget, SandboxProvider } from "@deskmates/contracts";
import { DockerProvider } from "./docker-provider.js";

/**
 * Factory the Gateway loads by module name (`packages/gateway/src/provider.ts`). Takes no
 * arguments on purpose: the Docker endpoint comes from DOCKER_HOST or the docker CLI context, and
 * this package must not depend on the Gateway's config type.
 */
export function createSandboxProvider(config?: {
  egressImage?: string;
  egressProxyDns?: readonly string[];
  egressProxyDohUrl?: string;
  privateEgressTargets?: readonly PrivateEgressTarget[];
}): SandboxProvider {
  return new DockerProvider({
    ...(config?.privateEgressTargets === undefined
      ? {}
      : { privateEgressTargets: config.privateEgressTargets }),
    ...(config?.egressImage === undefined ? {} : { egressProxyImage: config.egressImage }),
    ...(config?.egressProxyDns === undefined ? {} : { egressProxyDns: config.egressProxyDns }),
    ...(config?.egressProxyDohUrl === undefined
      ? {}
      : { egressProxyDohUrl: config.egressProxyDohUrl }),
    ...(process.env.DESKMATES_HOST_TARGET?.trim()
      ? { hostTarget: process.env.DESKMATES_HOST_TARGET.trim() }
      : {}),
  });
}

export { DockerClient, DOCKER_API_VERSION, dockerApiError } from "./docker-client.js";
export {
  assertPlaintextEndpoint,
  DEFAULT_UNIX_SOCKET,
  type DockerEndpoint,
  describeEndpoint,
  endpointFromDockerContext,
  parseDockerHost,
  resolveDockerEndpoint,
} from "./docker-endpoint.js";
export {
  containerName,
  DEFAULT_HOST_TARGET,
  DEFAULT_EGRESS_PROXY_IMAGE,
  DEFAULT_READY_TIMEOUT_MS,
  DockerProvider,
  type DockerProviderOptions,
  MANAGED_LABEL,
  networkName,
  NOVNC_CONTAINER_PORT,
  proxyName,
  ROLE_LABEL,
  VNC_PASSWORD_ENV,
  WORKSPACE_LABEL,
} from "./docker-provider.js";
export {
  type DemuxedOutput,
  DockerStreamDemuxer,
  demuxDockerStream,
  encodeDockerFrame,
} from "./docker-stream.js";
export { ENV_FILE_PATH, parseEnvFile, renderEnvFile } from "./env-file.js";
export {
  DEFAULT_CONTAINER_HOST_ALIAS,
  gatewayHostForContainer,
  gatewayUrlForContainer,
} from "./host-address.js";
