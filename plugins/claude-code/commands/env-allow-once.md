---
description: Bypass secret redaction for the next message.
allowed-tools: Read
model: default
---
By default, envseal redacts anything that looks like a secret before it reaches the model. If a message is a false positive and must be sent verbatim:

- Tell the user to re-type the message with `/env:allow-once` as the **first line**. The user-prompt-submit hook recognises that marker, skips redaction for that one message, then automatically re-arms itself.

Only meaningful for the very next message; it never persists across turns. If redaction keeps flagging a legitimate string, prefer `/env:setup` or `/env:set` so the value is stored out-of-band instead of pasted.
