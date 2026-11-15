# Uploads — attach files to chat (#upload, v2 #59)

Attach an image from the composer (📎), type a line of text, send: the files
upload first, then ride the message.

## Flow

1. **Composer** — 📎 opens the image picker (png/jpeg/webp, multiple ok).
   Picked files show as removable thumbnail chips. They stay attached across
   edits and ride the **next text send** (Enter). An empty text with chips is
   a valid message.
2. **Upload** — `POST /api/upload?sid=<client>&name=<file>` with the raw
   bytes (Bearer token, like every `/api` route). The gateway sniffs magic
   bytes (headers lie), caps at 10MB, sanitizes every path segment, and
   stores under `~/.pppi/uploads/<sid>/<timestamp>-<name>`. The response
   carries the reference: `{ path, name, mime, size, url }`.
3. **Agent delivery** — images become pi `ImageContent` parts (base64) on the
   prompt: **vision models actually see the screenshot**. Non-vision models
   get nothing visual — for them (and for tools), a readable line is appended
   per attachment: `[attachment] name (mime, sizeB) — /absolute/path`.
4. **Display** — sent messages render image thumbnails (tap → full size in a
   new tab via the token-authenticated `/api/uploads/<sid>/<file>?token=…`
   route — `img` tags can't send headers); non-images render as name+size
   chips.

## Voice path

Voice sessions can't upload; chips attach to the **next text turn**. Pick the
file(s), talk as usual, then type your caption and send — the attachments
ride that message.

## Per-model behavior

- **Vision models** (e.g. multimodal pi providers): the image arrives as a
  proper image part — ask "what's in this screenshot?" and it looks.
- **Text-only models**: the model sees the `[attachment] … — path` line and
  can open/read the file with its tools (the path is server-local).

## v2 (#59): general formats + Android parity + history

- **Allowlist**: images (png/jpeg/webp, magic-sniffed — unchanged) plus
  documents by extension: **pdf, txt, md, csv, json, xml, yaml, log**. PDFs
  are `%PDF-` magic-checked; anything else is rejected with the supported
  list. No generic binary catch-all (deliberate security posture). Cap is
  **20MB**.
- **Per-type agent delivery**: images → ImageContent vision parts
  (unchanged); text-ish types inline a **short preview** (first ~800 chars,
  JSON-escaped) alongside the `[attachment] … — path` line so the agent
  knows what the file is without opening it; **PDFs stay path-only** (the
  agent opens them with its tools).
- **Android composer parity**: 📎 in the composer opens the system picker
  (photo/document), uploads via the same endpoint, chips + image thumbs in
  chat and history.
- **History reload re-attaches**: the gateway logs every chat-with-
  attachments to `~/.pppi/uploads/messages.jsonl` and merges refs back into
  hello/history entries (matched by timestamp + text, since ChatEntry ids
  are regenerated per fetch).
