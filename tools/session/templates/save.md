<!-- tpm:if !session.enabled -->
tpm-session is disabled by config (`session.enabled: false`) — say "session lifecycle disabled by config" and do nothing else.
<!-- tpm:endif -->
<!-- tpm:if session.enabled -->
## `tpm-session save` — checkpoint the notes

Confirm a session is open: `tpm session current --state`. **If `state` is `not-opened`, say so and run `tpm session compose --mode open` instead** — `save` never silently opens a session on its own; that is bare invocation's job, not an explicit `save`'s.

<!-- tpm:if !session.notes.enabled -->
Notes are disabled by config (`session.notes.enabled: false`): skip the ritual, say "notes disabled by config" in one line, then print the footer below.
<!-- tpm:endif -->
<!-- tpm:if session.notes.enabled -->
<!-- tpm:inject save-ritual -->

Tools for this mode:

<!-- tpm:inject tools-write -->
<!-- tpm:endif -->

<!-- tpm:inject tools-common -->

<!-- tpm:inject footer -->
<!-- tpm:endif -->
