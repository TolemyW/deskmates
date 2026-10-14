# People and roles

What it is: who may use a team (a tenant) and with which role. A team holds its own workspaces,
bots, chats, tasks, costs and Knowledge. Everyone in a team sees all of it; the role decides what
they may change.

Where you find it: **People** in the sidebar, shown to Admins and Owners. The sidebar footer shows
your name, role and team; with more than one team, a **Team** switcher appears there.

## What each role may do

Each role includes everything in the columns to its left. Platform maintenance is separate and adds
nothing inside a team: "-" means the person's team role decides.

| Action | Member | Admin | Owner | Platform maintainer |
|---|---|---|---|---|
| See every workspace, bot, thread, run, file, task, cost and Knowledge document of the team | yes | yes | yes | - |
| Chat, start threads, add bots to threads, open a bot's private chat | yes | yes | yes | - |
| Create, edit and accept tasks | yes | yes | yes | - |
| Decide approvals (including Always and "allow this site") and turn-continuation asks | yes | yes | yes | - |
| Take over and view desktops | yes | yes | yes | - |
| Curate learned memory, edit a bot's `MEMORY.md`, review memory suggestions | yes | yes | yes | - |
| Propose Knowledge; acknowledge cost alerts | yes | yes | yes | - |
| Leave the team (never its last active Owner) | yes | yes | yes | - |
| Create and change workspaces, including the egress allowlist; restart a workspace | no | yes | yes | - |
| Create and change bots: SOUL, model, schedules, avatar, webhook token | no | yes | yes | - |
| Create and delete approval rules | no | yes | yes | - |
| Register database connectors; connect and revoke integration accounts | no | yes | yes | - |
| Create and delete cost alert rules | no | yes | yes | - |
| Review (publish or reject) and edit Knowledge | no | yes | yes | - |
| See People; invite Members; remove Members | no | yes | yes | - |
| Change any role (including making an Owner); invite Admins; remove Admins and Owners | no | no | yes | - |
| Adopt and unadopt integration providers, set OAuth apps, override action tiers | no | no | no | yes |
| Set prices, read the runtime status, clean up Knowledge version files | no | no | no | yes |
| Teams, users, passwords, SSO providers and policy, maintainers, backup, restore | no | no | no | command line on the Gateway host only |

The table is taken from the [multi-tenant runbook](../runbooks/multi-tenant.md), which states what
the Gateway enforces today. Screens hide or disable what your role cannot do and say which role
can ("Only an Admin or Owner can ...").

## Invite someone

On **People**, under **Invite someone**, pick one of two ways. Both add the person to this team
with the role you choose (Member, or Admin when an Owner adds them); nobody is ever made an Owner
this way. There is no mail service: you send the link or the login details yourself.

- **Invite by link** (recommended): press **Create invitation link**, then **Copy invitation
  link**. Whoever opens it chooses their own username, display name and password, or uses
  **Already have an account? Sign in to join** to join with the account they have. The link works
  once and expires after seven days; if it was used, revoked or has expired, the page says which.
  When the team trusts an SSO provider, **How they sign in** can instead require that provider to
  confirm a specific email as verified.
- **Create account**: you choose the username and display name. Deskmates generates an initial
  password and shows it once, with **Copy login details** for the sign-in address, username and
  password. Ask the person to change it under **Account settings → Change password**. A username
  that already exists is refused; to add an existing account, invite it by link instead.

A team that requires single sign-on refuses both local paths; invite by SSO email there. Open
invitations are listed below and can be revoked. Links issued before this change, which name a
login name, still work for that login name.

## Change or remove someone

The **Members** table lists everyone with their role. An Owner changes any role, including making
another Owner; an Admin removes Members only; anyone may leave. The last active Owner can never be
demoted or removed. A role change or removal ends that person's access at once, including open
event streams and desktop control.

## Your account

Select your photo and name in the sidebar footer (the photo alone in the collapsed sidebar and the
mobile header) to open **Account settings**; it is the one place for your account, preferences and
signing out, and there is no separate Settings button. Every role can change its own account
there; nobody can change another person's through it.

- **Profile**: **Change photo** takes a PNG, JPEG or WebP image (larger photos are shrunk in the
  browser to fit 512 KB), shows a preview, and uses it only after **Save photo**. **Remove photo**
  returns to your initials. **Display name** is how your team sees you; it is not your login name,
  which stays the same and is shown below it.
- **Password**: enter your current password and the new one twice, then **Change password**. Your
  other devices are signed out and this one stays signed in. An account that signs in only through
  SSO has no Deskmates password; its identity provider manages it. If your account has a password but
  you signed in through SSO, sign in with the password to change it.
- A later SSO sign-in never overwrites the display name or photo you saved here. Deskmates never
  loads a photo from your identity provider or any other web address.
- **Preferences**: **Language** changes the interface at once and is saved to your account, so it
  follows you to any browser. **Appearance** is light, dark, or your system setting; it is kept in
  this browser only.
- **Connect an agent**: a prompt you paste into an agent you run (Claude Code, or any agent that
  reads skills). It tells the agent to download this Deskmates's skill file, save a credential for
  this instance, and check it by listing your workspaces. An Admin or Owner presses **Create agent
  token** first: that makes a service principal named after you, with your role, and puts its
  token into the prompt. The token is shown nowhere else, so copy the prompt right away; a lost
  token means a new one, and an Admin can disable the old one under **People**. A Member sees the
  same prompt with a placeholder and asks an Admin for a token. The agent then acts with that role,
  and every message it posts is visible to the team like any other. See
  [Using Deskmates from another agent](using-deskmates-from-another-agent.md).
- **Sign out**: **Sign out** ends this browser's session and returns to the sign-in page.
  **Sign out on every device** ends all your sessions, this one included.

## Sign-in, sessions and teams

- Password sign-in, and SSO through an OIDC provider when the platform maintainer has set one up.
  A team may require SSO; then a password session uses **Open <team> with <provider>** in the
  team switcher.
- You stay signed in on a browser until you sign out or the session expires. **Account settings →
  Sign out on every device** ends all your sessions.
- With several teams, the **Team** switcher moves between them; nothing of one team stays on
  screen in the other.

## What this cannot do

- Roles control people, not bots. Inside a workspace there is no access control between bots;
  bots are separated by `SOUL.md`, working directory, prompt and ledger attribution. These are
  soft distinctions, not security boundaries.
- A Member sees everything in the team. To keep something from a person, it must be in a
  different team; to keep it from a bot, in a different workspace.
- The team boundary itself (ADR-0022) is proposed and not yet accepted by the owner. Its migration
  and two-team gates have run on the test host, but a second team must not be exposed to real
  users until the owner accepts ADR-0022 (see the [M4 status ledger](../design/m4-status-2026-10-04.md)
  and [ADR-0022](../adr/0022-tenant-isolation-and-user-sessions.md)).
- Platform maintenance (teams, users, passwords, SSO, backup) has no screen; it is done with the
  command line on the Gateway host.
- The shared operator token acts as an Owner of the Default Tenant with no person behind it. Do
  not hand it to people; invite them instead.
