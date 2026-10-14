# slack.post\_message

Post a Slack message. Use text for plain messages, or blocks for rich Block Kit layouts with text as fallback.

## Execute

Call the `execute_action` tool with these arguments:

```json
{
  "actionId": "slack.post_message",
  "input": {
    "channelId": ""
  }
}
```

Add `connectionName` to run the action with a named connection instead of the default one.

## Input Parameters

| Name          | Required | Type      |
| ------------- | -------- | --------- |
| `channelId`   | Yes      | `string`  |
| `text`        | No       | `string`  |
| `blocks`      | No       | `array`   |
| `attachments` | No       | `array`   |
| `unfurlLinks` | No       | `boolean` |
| `unfurlMedia` | No       | `boolean` |
| `metadata`    | No       | `object`  |

- `channelId`

  The Slack conversation or channel ID.
- `text`

  Plain text message content. When blocks are provided, Slack uses this as notification and accessibility fallback text.
- `blocks`

  Slack Block Kit blocks to render in the message.
- `attachments`

  Slack legacy attachments to include in the message.
- `unfurlLinks`

  Whether Slack should unfurl links in the message.
- `unfurlMedia`

  Whether Slack should unfurl media in the message.
- `metadata`

  Slack message metadata to attach to the message.

## Required Scopes

- `chat:write`

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
