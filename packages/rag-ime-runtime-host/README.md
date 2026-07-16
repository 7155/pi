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

## Stable prompt prefix and discovery

Each Session starts with one deterministic model-facing prefix:

- the product Persona/System Prompt;
- a concise, name-sorted Skill Catalog;
- fixed `skill_search`, `skill_load`, `tool_search`, and `tool_load` schemas.

OpenAI-compatible Chat Completions requests are stateless, so the physical HTTP
payload still contains the same active tool schemas on later turns. The full
product catalog remains in the Host and is not registered as model-facing tools.
The Host keeps active schemas and ordering byte-stable so they remain in the
provider's cached prefix. Only new user messages, tool results, retrieval
evidence, loaded product tools, and catalog change records belong in the
incremental suffix.

`skill_search` returns catalog metadata only. `skill_load` reads one exact
managed Skill and strips its frontmatter, so full Skill bodies are disclosed
only when needed. `tool_search` returns matching product names and descriptions
without parameter schemas. `tool_load` dynamically activates one exact schema
in the next Provider tool set; its tool result stays compact instead of
repeating that schema in message history. Gateway execution, validation, risk
policy, and native approval remain unchanged after activation.

Tool manifests are canonicalized before registration. Re-sending an equivalent
manifest is a no-op. Permission, profile, or risk-only changes append a hidden
`rag-ime.runtime-catalog-change` message and do not rebuild Tool Schema.
Adding/removing or changing an inactive catalog tool also avoids a reload.
Changing or removing an already active tool is an explicit cache-generation
boundary: the Session reloads that active set once, then appends the same typed
change record so history explains the new capability. Plugin/Skill reloads
follow the same revision-and-delta contract.

Conversation branches use `session.fork.candidates` and `session.fork`. The
candidate ids come from Pi's session tree. A fork creates a distinct native Pi
transcript at the selected user-message anchor and opens it under a new product
`sessionId`; the source transcript and source binding are never rewritten.

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
