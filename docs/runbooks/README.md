# runbooks

Operational how-tos. Add one file per procedure once it exists: bring up a dev stack, rotate the model token, recover a stuck run, rebuild the bot image, take over a browser session.

- [Deskmates naming upgrade](deskmates-naming-upgrade.md): current names, rebuilding
  images, and precautions when migrating an existing installation.
- [Image tags and artifact naming](image-tags-and-artifact-naming.md):
  content-addressed image tags, the two moving aliases, evidence directory and
  branch names, and what to prune.
- [Stable release and deployment](stable-release.md): tag, CI build, ship,
  install, T2 verify, activate and roll back the long-lived instance on Testbox.
- [Grafana for run observability](grafana.md): `stable.sh grafana init|start|stop|status`, the
  obs datasource, settings, upgrades and troubleshooting (ADR-0046).
- [Multi-tenant operation](multi-tenant.md): enable `DESKMATES_TENANCY=multi`, connect an OIDC
  provider and enforce SSO per tenant, members and invitations, backup and restore.
- [SearXNG for web search](searxng.md): `stable.sh searxng init|start|stop|status`, `SEARCH_URL`,
  the per-workspace switch and troubleshooting (ADR-0049).
- [Public mirror](public-mirror.md): the private and public remotes, what never enters a
  tracked file, the identifier scan and pre-push hook, and the one-time re-root.
- [Workspace files](workspace-files.md): putting files into a workspace's `/work` so they are
  owned by root and writable by its bots.
