---
name: deskmates-collaboration
description: Delegate focused work to other bots and deliver traceable results through Deskmates.
---

# Deskmates collaboration

1. Keep one owner for the outcome. Delegate only a bounded subtask with the context, expected artifact, and completion condition the recipient needs.
2. In a shared chat, mention the member who should respond. For a configured teammate outside the chat, use `message_bot(to, body, attachments)` and include workspace artifact paths rather than copying large content.
3. Do not send duplicate requests while a teammate is still running. Use the recorded handoff and outcome instead of guessing progress.
4. When work belongs to a linked task, finish with `task_deliver` and include a concise summary plus the exact artifact paths. Delivery does not mean the human accepted it.
5. Use `thread_post` for an interim update only when it helps the human or another member act; avoid status chatter.
6. Ask for human browser takeover when a login, MFA step, or visual judgment requires it. State what should be ready when the browser is handed back.
7. Report failures and partial results to the delegator with the blocker and the safest next step.
