# slack.upload\_file

Upload a file to Slack using the current external upload flow. Provide fileUrl; binary content is fetched by the connector runtime.

## Execute

Call the `execute_action` tool with these arguments:

```json
{
  "actionId": "slack.upload_file",
  "input": {
    "filename": "",
    "fileUrl": ""
  }
}
```

Add `connectionName` to run the action with a named connection instead of the default one.

## Input Parameters

| Name             | Required | Type     |
| ---------------- | -------- | -------- |
| `filename`       | Yes      | `string` |
| `fileUrl`        | Yes      | `string` |
| `title`          | No       | `string` |
| `channelId`      | No       | `string` |
| `initialComment` | No       | `string` |
| `threadTs`       | No       | `string` |
| `mimeType`       | No       | `string` |
| `altText`        | No       | `string` |
| `snippetType`    | No       | `string` |

- `filename`

  The file name Slack should display.
- `fileUrl`

  A URL whose response body should be uploaded to Slack.
- `title`

  Optional file title shown in Slack.
- `channelId`

  The Slack conversation or channel ID.
- `initialComment`

  Optional message text to post with the file.
- `threadTs`

  The Slack message timestamp, for example '1711.0001'.
- `mimeType`

  The content type to send while uploading the file.
- `altText`

  Alternative text for the uploaded file when Slack supports it.
- `snippetType`

  Slack snippet type for text snippets.

## Required Scopes

- `files:write`

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
