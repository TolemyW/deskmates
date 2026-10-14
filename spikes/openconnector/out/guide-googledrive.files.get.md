# googledrive.files.get

Get metadata for a Drive file by ID, or download stored file content with alt=media.

## Execute

Call the `execute_action` tool with these arguments:

```json
{
  "actionId": "googledrive.files.get",
  "input": {
    "fileId": ""
  }
}
```

Add `connectionName` to run the action with a named connection instead of the default one.

## Input Parameters

| Name                  | Required | Type      |
| --------------------- | -------- | --------- |
| `fileId`              | Yes      | `string`  |
| `includeSharedDrives` | No       | `boolean` |
| `alt`                 | No       | `"media"` |
| `acknowledgeAbuse`    | No       | `boolean` |

- `fileId`

  The ID of the Google Drive file to retrieve.
- `includeSharedDrives`

  Whether the request supports files in shared drives.
- `alt`

  Return stored file content instead of metadata.
- `acknowledgeAbuse`

  Whether the caller acknowledges the risk of downloading known malware or other abusive files.

## Required Scopes

- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive.metadata.readonly`

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
