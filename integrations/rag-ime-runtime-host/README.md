# Pi RAG IME Runtime Host

This private integration hosts Pi Coding Agent SDK sessions for the Wisdom
Weasel product. It is deliberately kept outside upstream Pi's `packages/*`
workspace so product policy and protocol code do not alter upstream package or
lockfile ownership.

The integration targets Pi `0.84.2` and exposes a versioned JSONL protocol over
stdin/stdout. Callers must not parse or edit Pi session files directly.

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

The CLI uses strict byte-oriented JSONL framing:

- only LF (`0x0A`) terminates a record;
- CRLF is accepted by removing one CR immediately before LF;
- Unicode line and paragraph separators remain part of JSON strings;
- malformed UTF-8, oversized records, and an unterminated final record are
  rejected before dispatch.

The host maintains a bounded LRU session pool. Eviction closes a Pi SDK session
without deleting its persisted transcript, allowing later recovery through the
normal session manager.

## Stable prompt prefix and discovery

Each Session starts with one deterministic model-facing prefix:

- the product Persona/System Prompt;
- a concise, name-sorted product Skill Catalog whose entries contain `name`,
  `when[]`, `does`, and optional `notFor[]`;
- an authorized product-tool route catalog containing only `name` and a bounded
  `does` summary;
- fixed `skill_search`, `skill_load`, `tool_search`, and `tool_load` schemas.

The Runtime Host does not own product Skills. The product supplies managed paths
through `RAG_IME_PI_SKILL_PATHS`; those paths are always loaded. Pi and Codex
Skills are separate, per-session opt-ins (`piSkillsEnabled` and
`codexSkillsEnabled`) and both default to false. Pi roots default to
`$PI_CODING_AGENT_DIR/skills` or `~/.pi/agent/skills`. Codex roots default to
`$CODEX_HOME/skills`, its `.system` subtree, and `~/.agents/skills`. Operators
may replace those source roots through `RAG_IME_PI_USER_SKILL_PATHS` and
`RAG_IME_CODEX_SKILL_PATHS`; workspace and package auto-discovery stays off.

The product-owned `RAG_IME_PI_SKILL_ROUTING_CARDS` file overlays concise
`when[]`/`does`/`notFor[]` metadata onto legacy external Skills while their full
bodies remain at the original paths for `skill_load`. Routing cards are parsed
inside this integration rather than patching upstream Pi Skill types. When that
catalog is present, the Host also resolves matching installed Codex plugin
Skills from the local plugin cache. Cached Skills without a product-owned
routing card stay hidden, so an unrelated cache entry cannot silently expand
context.

Tool disclosure follows the same three levels without mutating the stable
prefix: the initial route catalog has no parameters, `tool_search` returns the
full description/profile/risk, and `tool_load` discloses one parameter schema.
`tool_load` emits upstream Pi's `addedToolNames`, allowing Pi 0.84 deferred tools
to anchor the new schema at the tool-result point instead of rebuilding the
cached prefix.

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
change record so history explains the new capability. Plugin and Skill reloads
follow the same revision-and-delta contract.

## Context and compaction

Session memory and one-turn retrieval context remain product-owned. They are
injected through `before_agent_start` and are not stored as fake user messages.
After compaction, the integration refreshes the product Session context but does
not mutate Pi's authoritative `session_compact` settlement. The refreshed
context is composed during the next normal provider start. Compaction failures
and aborts are reported through Pi 0.84's `session_compact_failed` lifecycle
event and enter the same durable product outbox.

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

Run commands from the repository root:

```sh
npm ci --ignore-scripts
npm run build:rag-ime-runtime-host
npm run check
npm run test:rag-ime-runtime-host
```

The focused test command covers protocol framing, Session lifecycle, context
refresh, tool and Skill discovery, plugins, workflow control, lifecycle outbox,
stateless completions, and concurrency behavior.
