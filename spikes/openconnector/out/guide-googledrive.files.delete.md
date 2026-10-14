# googledrive.files.delete

Permanently delete a Drive file or folder by ID.

## Execute

Call the `execute_action` tool with these arguments:

```json
{
  "actionId": "googledrive.files.delete",
  "input": {}
}
```

Add `connectionName` to run the action with a named connection instead of the default one.

## Input Parameters

| Name                  | Required | Type      |
| --------------------- | -------- | --------- |
| `fileId`              | No       | `string`  |
| `includeSharedDrives` | No       | `boolean` |

- `fileId`

  The ID of the file.
- `includeSharedDrives`

  When true, includes files from shared drives.

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
