import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CHANNEL_NAME_PATTERN,
  CHANNEL_PLUGIN_API_VERSION,
  type ChannelPlugin,
  type ChannelPluginModule,
} from "@deskmates/contracts";

export interface ReleaseChannelPluginEntry {
  id: string;
  version: string;
  apiVersion: number;
  entry: string;
  sha256: string;
  /** Every JavaScript module in the bundled provider tree, including transitive imports. */
  files: readonly { path: string; sha256: string }[];
}

export interface ReleaseChannelPluginManifest {
  version: 1;
  plugins: readonly ReleaseChannelPluginEntry[];
}

export interface ChannelPluginLoadFailure {
  id: string;
  message: string;
}

export interface LoadedChannelPlugins {
  plugins: Map<string, ChannelPlugin>;
  failures: ChannelPluginLoadFailure[];
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function validEntry(entry: unknown): entry is ReleaseChannelPluginEntry {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as Partial<ReleaseChannelPluginEntry>;
  return (
    typeof value.id === "string" &&
    CHANNEL_NAME_PATTERN.test(value.id) &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    Number.isInteger(value.apiVersion) &&
    typeof value.entry === "string" &&
    value.entry.length > 0 &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.every(
      (file) =>
        file &&
        typeof file.path === "string" &&
        file.path.length > 0 &&
        typeof file.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(file.sha256),
    )
  );
}

/**
 * Load only entries pinned in one release manifest. Every entry is beneath that manifest's root,
 * hash checked before evaluation, and ABI checked again on the exported plugin.
 */
export async function loadReleaseChannelPlugins(
  manifestPath: string,
): Promise<LoadedChannelPlugins> {
  const failures: ChannelPluginLoadFailure[] = [];
  const plugins = new Map<string, ChannelPlugin>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      plugins,
      failures: [
        { id: "release-manifest", message: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
  const manifest = parsed as Partial<ReleaseChannelPluginManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.plugins)) {
    return {
      plugins,
      failures: [{ id: "release-manifest", message: "unsupported channel manifest" }],
    };
  }
  const root = resolve(dirname(manifestPath));
  for (const raw of manifest.plugins) {
    const id = raw && typeof raw === "object" && "id" in raw ? String(raw.id) : "invalid";
    try {
      if (!validEntry(raw)) throw new Error("invalid release plugin entry");
      if (raw.apiVersion !== CHANNEL_PLUGIN_API_VERSION)
        throw new Error("incompatible plugin API version");
      const file = resolve(root, raw.entry);
      if (!inside(root, file)) throw new Error("plugin entry leaves the release plugin root");
      const pinned = new Set<string>();
      for (const asset of raw.files) {
        const assetFile = resolve(root, asset.path);
        if (!inside(root, assetFile))
          throw new Error("plugin asset leaves the release plugin root");
        if (pinned.has(assetFile)) throw new Error("duplicate plugin asset");
        pinned.add(assetFile);
        const assetBytes = await readFile(assetFile);
        const assetHash = createHash("sha256").update(assetBytes).digest("hex");
        if (assetHash !== asset.sha256)
          throw new Error("plugin asset hash does not match the release manifest");
      }
      if (!pinned.has(file)) throw new Error("plugin entry is not pinned as a release asset");
      const bytes = await readFile(file);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== raw.sha256)
        throw new Error("plugin entry hash does not match the release manifest");
      const module = (await import(pathToFileURL(file).href)) as Partial<ChannelPluginModule>;
      const plugin = module.channelPlugin;
      if (!plugin || plugin.manifest.apiVersion !== CHANNEL_PLUGIN_API_VERSION) {
        throw new Error("plugin export has an incompatible API version");
      }
      if (plugin.manifest.id !== raw.id || plugin.manifest.version !== raw.version) {
        throw new Error("plugin export does not match its release manifest");
      }
      if (plugins.has(raw.id)) throw new Error("duplicate plugin id");
      plugins.set(raw.id, plugin);
    } catch (error) {
      failures.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { plugins, failures };
}
