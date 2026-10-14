# googledrive.files.list

List Google Drive files using the official Drive query and pagination parameters.

## Execute

Call the `execute_action` tool with these arguments:

```json
{
  "actionId": "googledrive.files.list",
  "input": {}
}
```

Add `connectionName` to run the action with a named connection instead of the default one.

## Input Parameters

| Name                        | Required | Type      |
| --------------------------- | -------- | --------- |
| `corpora`                   | No       | `string`  |
| `corpus`                    | No       | `string`  |
| `driveId`                   | No       | `string`  |
| `includeItemsFromAllDrives` | No       | `boolean` |
| `includeLabels`             | No       | `string`  |
| `includePermissionsForView` | No       | `string`  |
| `orderBy`                   | No       | `string`  |
| `pageSize`                  | No       | `integer` |
| `pageToken`                 | No       | `string`  |
| `q`                         | No       | `string`  |
| `spaces`                    | No       | `string`  |
| `supportsAllDrives`         | No       | `boolean` |
| `teamDriveId`               | No       | `string`  |

- `corpora`

  Bodies of items to which the query applies.
- `corpus`

  The source of files to list.
- `driveId`

  ID of the shared drive to search.
- `includeItemsFromAllDrives`

  Whether both My Drive and shared drive items should be included in results.
- `includeLabels`

  A comma-separated list of label IDs to include in labelInfo.
- `includePermissionsForView`

  Specifies which additional view's permissions to include in the response.
- `orderBy`

  A comma-separated list of sort keys.
- `pageSize`

  The maximum number of files to return per page.
- `pageToken`

  The token for continuing a previous list request.
- `q`

  A Google Drive query string for filtering files.
- `spaces`

  A comma-separated list of spaces to query.
- `supportsAllDrives`

  Whether the request supports both My Drives and shared drives.
- `teamDriveId`

  Deprecated Team Drive ID.

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
