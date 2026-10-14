# googledrive.permissions.create

Create a permission on a Drive file or shared drive.

## Execute

Call the `execute_action` tool with these arguments:

```json
{
  "actionId": "googledrive.permissions.create",
  "input": {
    "role": "owner",
    "type": "user"
  }
}
```

Add `connectionName` to run the action with a named connection instead of the default one.

## Input Parameters

| Name                      | Required | Type                                                                               |
| ------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `fileId`                  | No       | `string`                                                                           |
| `role`                    | Yes      | `"owner" \| "organizer" \| "fileOrganizer" \| "writer" \| "commenter" \| "reader"` |
| `type`                    | Yes      | `"user" \| "group" \| "domain" \| "anyone"`                                        |
| `domain`                  | No       | `string`                                                                           |
| `emailAddress`            | No       | `string`                                                                           |
| `email_message`           | No       | `string`                                                                           |
| `expiration_time`         | No       | `string`                                                                           |
| `transfer_ownership`      | No       | `boolean`                                                                          |
| `supportsAllDrives`       | No       | `boolean`                                                                          |
| `allow_file_discovery`    | No       | `boolean`                                                                          |
| `move_to_new_owners_root` | No       | `boolean`                                                                          |
| `send_notification_email` | No       | `boolean`                                                                          |
| `useDomainAdminAccess`    | No       | `boolean`                                                                          |

- `fileId`

  The ID of the file.
- `role`

  The role granted by this permission.
- `type`

  The type of the grantee (user, group, domain, or anyone).
- `domain`

  The domain to which this permission refers (required for domain type).
- `emailAddress`

  The email address of the user or group (required for user or group type).
- `email_message`

  A custom message to include in the notification email.
- `expiration_time`

  The time at which this permission will expire (RFC 3339 date-time).
- `transfer_ownership`

  Whether to transfer ownership to the specified user (for owner role only).
- `supportsAllDrives`

  Whether the request supports both My Drives and shared drives.
- `allow_file_discovery`

  Whether the permission allows the file to be discovered through search.
- `move_to_new_owners_root`

  Whether to move the file to the new owner's My Drive root folder.
- `send_notification_email`

  Whether to send a notification email when sharing to users or groups.
- `useDomainAdminAccess`

  Issue the request as a domain administrator.

## Required Scopes

- `https://www.googleapis.com/auth/drive`

## Provider Permissions

No provider permissions are declared.

## Execution Policy

Allowed by the current execution policy.

No policy rules matched or restricted this action.

## Current Connection

This provider is not connected in the local runtime.

## Notes For Agents

- Use the `execute_action` tool above; do not call provider APIs directly unless the user asks.
- Send JSON with a top-level `input` object.
- Check the current connection and provider scopes before choosing actions on the user's behalf.
- If execution fails with a credential error, ask the user to connect the app in the local console.
