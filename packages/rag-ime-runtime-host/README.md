# Pi RAG IME Runtime Host

This private package hosts Pi Coding Agent SDK sessions for the Wisdom Weasel
product. It exposes a versioned JSONL protocol over stdin/stdout; callers must
not parse or edit Pi session files directly.

## Ownership boundary

- The host owns Pi model calls, `AgentSession` lifecycle, compaction, snapshots,
  dynamic tool registration, and the final `agent_settled` turn boundary.
- The product gateway owns Persona, memory and graph state, Rooms, approval
  policy, the authoritative tool catalog, and Web-facing product events.
- The IME sidecar stays outside this process so a model/runtime failure cannot
  block ordinary typing.

## Protocol

Every request contains `protocolVersion`, `id`, `method`, and `params`. Session
and turn operations carry stable `sessionId`, `turnId`, and `clientMessageId`
correlation fields. Run `hello` first to negotiate protocol version 2 and
capabilities.

The host maintains a bounded LRU session pool. Eviction closes a Pi SDK session
without deleting its persisted transcript, allowing later recovery through the
normal session manager.

## Managed plugins

Plugin changes use validate/preview/apply. Validation stages a bounded directory
without following symlinks. Apply requires the exact preview token, payload
digest, confirmation text, and product-owned approval token. Versions are
immutable and activation changes only the managed current pointer, so failed
installs do not replace the active version.

The Agent may create a draft or propose an installation. Only the product UI can
approve and apply it.

## Development

```sh
npm run build -w @earendil-works/pi-rag-ime-runtime-host
npm test -w @earendil-works/pi-rag-ime-runtime-host
```
