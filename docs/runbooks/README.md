# runbooks

Operational how-tos. Add one file per procedure once it exists: bring up a dev stack, rotate the model token, recover a stuck run, rebuild the bot image, take over a browser session.

- [Deskmates naming upgrade](deskmates-naming-upgrade.md): current names, rebuilding
  images, and precautions when migrating an existing installation.
- [Image tags and artifact naming](image-tags-and-artifact-naming.md):
  content-addressed image tags, the two moving aliases, evidence directory and
  branch names, and what to prune.
- [Stable release and deployment](stable-release.md): tag, CI build, ship,
  install, T2 verify, activate and roll back the long-lived instance on Testbox.
- [Multi-tenant operation](multi-tenant.md): enable `DESKMATES_TENANCY=multi`, connect an OIDC
  provider and enforce SSO per tenant, members and invitations, backup and restore.
- [Public mirror](public-mirror.md): the private and public remotes, what never enters a
  tracked file, the identifier scan and pre-push hook, and the one-time re-root.
