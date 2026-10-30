// The one place a provider plugin's third-party dependencies are declared and loaded (ADR-0047
// decision 15). A provider may use an SDK, but only through this registry: each entry names the
// one provider that uses it and its exact pinned package, and loads it with a dynamic `import()`
// the first time that provider asks, which is when one of its connections is opened. Provider code
// never imports a third-party package statically (`import type` is fine), so an installation that
// never connected a provider never loads that provider's dependencies, and a release can leave
// out the packages of a provider it does not ship. `provider-dependencies.test.ts` enforces it.
//
// To add one: pin the package exactly in `packages/channels/package.json` `dependencies`, add an
// entry below in sorted place (provider, then package), and in the provider's runtime write
// `const sdk = await loadProviderDependency<typeof import("pkg")>("provider", "pkg");`.
//
// WhatsApp's existing pinned packages predate this rule and stay where they are until WhatsApp's
// own ABI-2 change; they are listed in the test's grandfathered set, not here.

export interface ProviderDependency {
  /** The plugin id (its `src/<provider>/` directory) that uses the package. Exactly one. */
  provider: string;
  /** The npm package name, pinned to an exact version in this package's `dependencies`. */
  packageName: string;
  /** Why the provider needs it, for review. */
  reason: string;
  /** The only import of the package anywhere in `packages/channels`. */
  load: () => Promise<unknown>;
}

/** Sorted by provider, then package. WhatsApp's grandfathered QR encoder is also used here. */
export const PROVIDER_DEPENDENCIES: readonly ProviderDependency[] = [
  {
    provider: "wechat",
    packageName: "qrcode",
    reason: "Render iLink pairing codes locally",
    load: () => import("qrcode"),
  },
];

const loads = new Map<string, Promise<unknown>>();

/**
 * Load a declared dependency of `provider`, once per process. Refuses a package the registry does
 * not declare for that provider, so a dependency cannot be pulled in from anywhere else.
 */
export function loadProviderDependency<T>(
  provider: string,
  packageName: string,
  registry: readonly ProviderDependency[] = PROVIDER_DEPENDENCIES,
): Promise<T> {
  const entry = registry.find(
    (candidate) => candidate.provider === provider && candidate.packageName === packageName,
  );
  if (!entry)
    return Promise.reject(
      new Error(`${packageName} is not a declared dependency of the ${provider} channel`),
    );
  const key = `${provider}\n${packageName}`;
  let loaded = loads.get(key);
  if (!loaded) {
    loaded = entry.load().catch((error: unknown) => {
      loads.delete(key);
      throw error;
    });
    loads.set(key, loaded);
  }
  return loaded as Promise<T>;
}
