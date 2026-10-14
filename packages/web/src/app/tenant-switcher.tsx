import type { AuthTenantChoice, SsoProviderView } from "@deskmates/contracts";
import { Select } from "@deskmates/ui";
import { useT } from "../i18n/i18n-provider.js";

/**
 * The tenants this person belongs to. One the session may not enter yet (its policy needs SSO)
 * offers that tenant's providers instead of switching.
 */
export function TenantSwitcher({
  current,
  tenants,
  onSwitch,
  onStepUp,
}: {
  current: string;
  tenants: AuthTenantChoice[];
  onSwitch: (tenantId: string) => void;
  onStepUp: (tenant: AuthTenantChoice, provider: SsoProviderView) => void;
}) {
  const t = useT();
  if (tenants.length < 2) return null;
  return (
    <div className="tenant-switcher">
      <Select
        label={t("app.tenant.label")}
        id="tenant-switcher"
        value={current}
        onValueChange={(value) => {
          const tenant = tenants.find((t) => t.id === value);
          if (tenant?.enterable) onSwitch(tenant.id);
        }}
        options={[
          ...tenants.map((tenant) => ({
            value: tenant.id,
            label: tenant.enterable ? tenant.name : t("app.tenant.needsSso", { name: tenant.name }),
            disabled: !tenant.enterable,
          })),
        ]}
      />

      {tenants
        .filter((tenant) => !tenant.enterable)
        .flatMap((tenant) =>
          tenant.ssoProviders.map((provider) => (
            <button
              key={`${tenant.id}:${provider.id}`}
              type="button"
              className="link-button"
              onClick={() => onStepUp(tenant, provider)}
            >
              {t("app.tenant.openWith", { tenant: tenant.name, provider: provider.displayName })}
            </button>
          )),
        )}
    </div>
  );
}
