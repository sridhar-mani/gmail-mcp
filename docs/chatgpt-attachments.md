# ChatGPT conversation attachments

The Gmail MCP write tools accept files attached to the current ChatGPT conversation.

Supported tools:

- `create_draft`
- `update_draft`
- `send_message`
- `reply_all`

ChatGPT supplies each file as a temporary download URL and file metadata. The server validates the URL host, downloads the file over HTTPS, enforces the existing attachment size limits, and passes it through the same MIME attachment path used by staged and explicitly supplied attachments.

Use the top-level `files` parameter when calling one of these tools from ChatGPT. The existing `attachments` and staged-upload flows remain supported.
