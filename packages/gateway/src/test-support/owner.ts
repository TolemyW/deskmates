// Test fixture: the first account of a test database, as the removed `bootstrapOwner` made it:
// the protected root account (Owner of every workspace, ADR-0031 decision 8) and platform
// maintainer, with a chosen password instead of the default `admin` it would have to change.

import type { AuthService } from "../auth/auth-service.js";
import type { User } from "../auth/user-store.js";

export async function createOwner(
  auth: AuthService,
  input: { loginName: string; displayName: string; password: string },
  options: { root?: boolean } = {},
): Promise<User> {
  // `root: false` for a test that disables or removes this account, which the root forbids;
  // it is then an Owner of the workspaces that exist now only.
  const user = await auth.createUser({
    ...input,
    role: "owner",
    protectedRoot: options.root ?? true,
  });
  auth.users.setPlatformRole(user.id, "maintainer");
  return auth.users.getUser(user.id) as User;
}
