# slack.list\_channels

List Slack public channels visible to the connected Slack identity.

## Execute

Call the `execute_action` tool with these arguments:

```json
{
  "actionId": "slack.list_channels",
  "input": {}
}
```

Add `connectionName` to run the action with a named connection instead of the default one.

## Input Parameters

| Name    | Required | Type      |
| ------- | -------- | --------- |
| `limit` | No       | `integer` |

- `limit`

  The maximum number of channels to return.

## Required Scopes

- `channels:read`

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
