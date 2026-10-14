# slack.get\_channel\_messages

Get recent messages from a Slack conversation.

## Execute

Call the `execute_action` tool with these arguments:

```json
{
  "actionId": "slack.get_channel_messages",
  "input": {
    "channelId": ""
  }
}
```

Add `connectionName` to run the action with a named connection instead of the default one.

## Input Parameters

| Name         | Required | Type      |
| ------------ | -------- | --------- |
| `channelId`  | Yes      | `string`  |
| `limit`      | No       | `integer` |
| `cursor`     | No       | `string`  |
| `oldest`     | No       | `string`  |
| `latest`     | No       | `string`  |
| `inclusive`  | No       | `boolean` |
| `includeRaw` | No       | `boolean` |

- `channelId`

  The Slack conversation or channel ID.
- `limit`

  The maximum number of messages to return.
- `cursor`

  The Slack pagination cursor from a previous page. Omit for the first page.
- `oldest`

  Only return messages after this Slack timestamp, for example '1700000000.123456'. The message at exactly this timestamp is included only when inclusive is true.
- `latest`

  Only return messages before this Slack timestamp. Defaults to now. The message at exactly this timestamp is included only when inclusive is true.
- `inclusive`

  Include messages whose timestamp equals oldest or latest. Slack ignores this unless one of those bounds is set.
- `includeRaw`

  When true, each returned message also carries the untouched Slack record under raw, including its blocks, attachments, files and message metadata. Defaults to false.

## Required Scopes

- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`

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
