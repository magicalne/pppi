# Uploads — attach screenshots and files to chat (#upload)

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

## v1 limits (deliberate)

- Images only (png/jpeg/webp); other file types are a natural follow-up —
  the endpoint + references would carry them, only the sniff would widen.
- History reload does not re-attach: the live `user_message` echo renders
  thumbnails; older messages lose them after a reload (pi's history stores
  images in the session file, not as our references). Re-ask the agent if
  you need to look again.
- Android client: gateway + protocol are ready (additive fields with
  defaults in the Kotlin mirror); the composer UI is web-first, Android
  parity tracked separately.
