# NEXIOM changes

Upstream: OpenAI Codex `rust-v0.154.0`, commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`.

The SDK source is compiled directly into NEXIOM. Its Agent loop runs in the official Codex native binary; NEXIOM does not reimplement it.

`src/exec.ts` is modified to check an already-aborted signal, hide Windows console windows, and terminate the owned Windows process tree on cancellation or generator disposal. The upstream LICENSE and NOTICE are preserved. Other upstream source files are unmodified.
