# Pi 0.84.2 compatibility fixture

`session.jsonl` was emitted by the actual patched 0.84.2 `SessionManager`, using
the dependencies and lockfile of NWH main `0a9fd1255abd4a721687accf220cc6b75c63f8c9`.
It contains synthetic data only: a native custom opening scene, ordinary dialogue,
a private compiler span, and an untrusted legacy summary. It has format version 3.

Tests copy this fixture, relocate only the header's synthetic cwd, then exercise
Pi 1.0 resume, append and fork. The original bytes must remain unchanged; the old
summary must never be promoted to a trusted summary merely by opening the file.
