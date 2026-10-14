# Private-chat collaboration reminders (ADR-0024)

Contacts opens the Gateway's canonical private chat. Incoming collaboration
cards show the caller, request excerpt, actual run state and links to the exact
source message, collaboration conversation and run. The chat list includes a
request preview and per-operator unread badge. SSE and reconnect reload durable
activity; reading an open visible chat advances only its fetched watermark.
These cards do not send messages or initiate bot work.
