# googledrive.files.create

Create a Drive file with official File metadata and optional connector media upload content.

## Execute

Call the `execute_action` tool with these arguments:

```json
{
  "actionId": "googledrive.files.create",
  "input": {}
}
```

Add `connectionName` to run the action with a named connection instead of the default one.

## Input Parameters

| Name            | Required | Type      |
| --------------- | -------- | --------- |
| `name`          | No       | `string`  |
| `mimeType`      | No       | `string`  |
| `description`   | No       | `string`  |
| `parents`       | No       | `array`   |
| `starred`       | No       | `boolean` |
| `appProperties` | No       | `object`  |
| `properties`    | No       | `object`  |
| `contentBase64` | No       | `string`  |
| `text`          | No       | `string`  |

- `name`

  The name of the file.
- `mimeType`

  The MIME type of the file.
- `description`

  A short description of the file.
- `parents`

  A list of parent folder IDs to place the file in.
- `starred`

  Whether the user has starred the file.
- `appProperties`

  A collection of arbitrary key-value pairs which are private to the requesting app.
- `properties`

  A collection of arbitrary key-value pairs which are visible to all apps.
- `contentBase64`

  Connector media upload content encoded as a Base64 string.
- `text`

  Connector text media upload content.

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
