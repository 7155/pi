# Pi RAG IME Runtime Host

This private integration hosts Pi Sessions for Personal Agent Workbench.
It is deliberately kept outside upstream Pi's `packages/*`
workspace so product policy and protocol code do not alter upstream package or
lockfile ownership.

This source targets Pi `1.0.0` and exposes protocol 2 over versioned JSONL on
stdin/stdout. The previously reviewed product baseline was `0.99.2`; building
this Host does not activate it in an installed PAW. The Host owns transcript
writes and recovery; product-side history readers are read-only projections.

## Ownership boundary

- The host owns Pi model calls, Classic `AgentSession` or native Durable
  `Harness` lifecycle, compaction, snapshots,
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

`sessionBoundAbort` advertises target-bound ordinary Stop. A caller supplies an
exact turn and client identity, or the non-empty client identity of a pending
admission. Comparison and native cancellation signalling happen synchronously;
a replacement turn returns `ABORT_TARGET_MISMATCH` without being stopped.
An empty client identity is valid only with an exact turn (native Room turns).
The existing `cancelId`-based exact cancellation and recovery contract remains
separate. Paired PAW requires this capability rather than silently sending an
unbound Stop to an older Host; an unidentifiable pending turn waits for its
original identity instead of treating empty fields as a wildcard.

### Prompt admission and settlement

`session.prompt` returns the original turn/client identity and a typed
`disposition`: `started`, `queued`, or `handled`. A handled input or extension
command has already been processed and must not be replayed as a rejected
prompt. Its ACK includes the persisted exact `rag-ime.pi-turn-settlement.v1`
`settlement`, also available through the settlement APIs and public terminal
event. Consumers use that receipt's disposition to determine the outcome.

Pure handled completion uses `origin: prompt_preflight`,
`stopReason: prompt_handled`, and `disposition: completed`, with no
`finalMessage`. A command that starts a native Agent run retains its real
assistant result. If Stop cancels the command's nested admission, the handled
ACK can instead carry an aborted settlement with
`stopReason: prompt_preflight_cancelled`.

Preflight and command-owned nested prompts keep the original turn bound until
they exit. Stop signals their cancellation scopes and returns
`prompt_preflight` in `pendingOperations`, with `idle: false` and
`drained: false`, while work is still pending. Exact cancellation remains
`requested` until that work drains. A cancelled direct admission rejects
`PROMPT_ADMISSION_CANCELLED`; it cannot enter the Provider later. A nested
run's terminal event is deferred until its owning command handler also exits.

The CLI uses strict byte-oriented JSONL framing:

- only LF (`0x0A`) terminates a record;
- CRLF is accepted by removing one CR immediately before LF;
- Unicode line and paragraph separators remain part of JSON strings;
- malformed UTF-8, oversized records, and an unterminated final record are
  rejected before dispatch.

The host maintains a bounded LRU session pool. Eviction closes a Pi SDK session
without deleting its persisted transcript, allowing later recovery through the
normal session manager.

Gateway requests capture the active `turnId`, exact `clientMessageId` (including
the empty value used by Room turns), and Room capability before waiting for HTTP
capacity. A later turn cannot adopt a queued request. PAW persists admission by
Session and tool-call ID: a completed repeat returns its original receipt;
conflicting or uncertain outcomes require reconciliation instead of executing
again. Older clients without this additive binding retain receipt deduplication,
but do not acquire exact-turn cancellation protection. Rebuild the paired Host
payload to enable that protection.

## Experimental native Durable engine

`hello.capabilities.sessionEngines.durable` advertises explicit opt-in support.
New standalone Sessions send `runtimeEngine: durable` and the canonical owned
`durableStoreRef` on `session.open`; Classic remains the default. An existing
Session cannot change its engine, native Conversation or storage binding.
Managed-root aliases are canonicalized before comparing the requested path;
Durable subtree/Session symlinks and outside paths remain denied.

`DurableProductSession` implements the existing pool interface with one native
Harness/Conversation and its SQLite journal. A product extension document
links the immutable client message and argument fingerprint to native
submission/generation IDs and saved settlements. It owns no additional model
or Tool loop. An exclusive store lease is released only after owned callbacks
and cancellation operations have joined.

Opening or reading history is passive. Unfinished native input is reported as
`paused`, `recoverable` and an exact `activeTurn`. `session.resume` takes the
original turn/client IDs, never resubmits a prompt, and returns saved settlement
for terminal input. Empty or completed Sessions instead report `isIdle: true`,
`paused: false`, `recoverable: false` and no `activeTurn`, even though passive
open leaves the native scheduler paused. They accept a new input without a
resume request or replaying completed work. Lost admission responses reuse the
same request; changed arguments conflict before native deduplication. Public full history paginates
native entries independently of the compacted model-context head. Recent views
remain bounded and preserve original message and Tool identities.

Cancellation uses native `Conversation.abortRun` for the original submission.
Terminal input alone does not prove physical drain: captured generation/child
tasks must also finish. Exact `cancelId` intent is saved before waiting;
lookup repairs its state only from original native cancellation evidence.
Withdrawing a never-placed queued input records its queryable settlement and
queue update without publishing an execution terminal for a different active
input. `SESSION_ABORTING` rejects new admission while Stop is draining.

Gateway tools capture their immutable native ToolTask owner and original input
before awaiting capacity or HTTP. Product Gateway idempotency and receipts
remain authoritative; these tools are registered unsafe for native replay.
An interrupted effect is not automatically repeated. Native Tool discovery is
safe to replay under its recorded/current policy. This does not promise
exactly-once arbitrary external effects.

Durable supports text, configured models/thinking levels, Gateway tools,
compaction, exact Stop and explicit resume. Native MCP, Code Mode, managed
plugins/Skills, images, conversation fork/rewrite and command catalogs are
unavailable. `model.set` with a `maxTokens` override is also rejected: native
Conversation streaming does not carry that override. Engine capabilities are
explicit; unsupported controls do not fall back to Classic. Product Session
and transient context use the existing prompt envelope and native extension
sections bound to the admitted generation.

`test/durable-product-session.test.ts` exercises the public Host with native
Harness/SQLite and a faux ModelRuntime, including restart, unsafe-effect
recovery, exact generation cancellation, delayed drain, projection gaps and
history after compaction. It establishes controlled native behavior, not
configured Provider or installed foreground acceptance.

### Standalone Durable compaction recovery

`hello.capabilities.sessionCompactionRecovery` and Durable
`engineCapabilities.compactionRecovery` advertise exact compaction recovery.
When unfinished standalone native compactions are the only remaining work,
open, snapshot and control-state metadata expose `compactionTarget`:
`{ kind: "compaction", runtimeSessionId: piSessionId, taskIds: ["durable:task:N"] }`.
The list is the complete surviving task set, with nonempty unique positive
safe-integer IDs in string-lexicographic order (`10` before `2`), within the
existing request-size limit. It is never truncated. Owned ordinary children remain part of the native drain boundary;
unrelated native work prevents advertising or activating a compaction-only
target. There is no fabricated `activeTurn` for a compaction. A passive reopen
reports `paused: true`, `recoverable: true`, and `isIdle: false` until its native
tasks are terminal, even if `LiveDoc` has already removed its compaction status.

`session.resume({ sessionId, compactionTarget })` resumes original checkpoints
without creating another compaction. Its `rag-ime.pi-compaction-resume.v1`
response includes `accepted`, `runtimeEngine`, the exact target, `resumed`, and
current `state`. Terminal repeats return `resumed: false` without enabling
scheduling. `session.abort({ sessionId, compactionTarget })` marks all exact
targets before enabling scheduling, then joins outside the admission lane.
Its `rag-ime.pi-compaction-abort.v1` response includes `accepted`, `runtimeEngine`,
the exact target, `drained: true`, native `outcomes` (`completed`, `aborted`, or
`failed` for each task ID), and current `state`. It cannot return drain proof
while any named task or its ordinary owned work is unfinished. Repeats read the
original immutable outcomes and cannot stop a newer input or compaction.

Compaction targets are mutually exclusive with turn/client identities and
exact-cancel options. Malformed or mixed forms return `INVALID_PARAMS`;
wrong Session, task kind, ownership, missing tasks, partial current sets, or
unrelated work return `COMPACTION_TARGET_MISMATCH`. Duplicate manual compaction
admission returns `SESSION_BUSY`. Manual compaction during an already-running
input remains supported; it cannot implicitly restart paused unfinished work.
Native resume enables the whole Harness, so
validation checks the entire surviving work set, not merely one task ID.

`agent.event` payload `compaction_settled` carries the original target and
authoritative current control `state` only after all its native tasks are
terminal. Consumers use this to refresh controls after natural completion.
The earlier native `compaction_end` event is presentation only: it can precede
ordinary owned-child drain and must not clear recovery state. Tests in
`test/durable-compaction-recovery.test.ts` cover passive restart, complete-set
resume/Stop, malformed and stale identities, newer work, concurrent requests,
provider drain, and compaction completion held by an owned child.

## Native programmatic tool calling

Classic product Sessions load Pi's built-in `codemode` extension. `session.open`
accepts `codemodeMode`: `on` (default, normal tools plus code), `only` (code
exposes the callable catalog), or `off`. `session.codemode.set` changes the
actual mode only while idle and returns the effective `codemodeMode`.
Snapshots and fork profiles preserve that state. The sandbox calls the same
registered tools through the original product Gateway; nested calls keep
`parentToolCallId` and Pi persists their exact arguments in
`ToolResultMessage.nestedCalls`. Managed Sessions expose the native `models`
namespace with one typed allowed reference: classifier `typesafe/jev-latest`.
Catalog getters filter all other references and omit connection headers/URLs;
classification checks the current policy again after the native four-call
limiter. Image generation is not exposed. Existing SDK `models: true` and
`models: false` behavior remains compatible for other embeddings.

Classifier calls use Pi's existing `ModelRuntime.classify`, cancellation signal,
and nested usage/cost rows. Script-supplied connection/auth fields never select
the transport. Managed Host options supply a direct, caller-owned HTTP fetch
without changing other Providers' proxy dispatcher. The optional owned
`RAG_IME_PI_TYPESAFE_ENDPOINT` environment value is a trusted **complete** HTTP(S)
endpoint, not a base URL or model argument. `TYPESAFE_API_KEY` uses Pi's native
read-only environment auth. CodeMode observes key/endpoint configuration at Host
startup; changes require the next Host startup, without automatic restart or
credential-file writes.

The relocated Runtime payload must include the native codemode worker and
QuickJS WASM. The explicit test-only `codemode` scenario exercises these
assets through normal Session RPC; it is not a live model or Room acceptance.

## Stateless native classification

Protocol 2 additively advertises `statelessClassification`. `classification.once`
accepts an opaque bounded `requestId`, optional opaque `dispatchId`, JSON `state`
object, a non-empty native Choice/Score `questions` map, and `timeoutMs` between
1 and 300000. A private per-request `apiKey` and trusted complete `endpoint` may
be supplied by the product adapter; neither belongs in model context, events,
transcripts, or public status. Each call uses fresh supplied auth, Pi's canonical
`typesafe/jev-latest` classifier, and `maxRetries: 0`. It creates no Agent Session
and does not consume a Session-pool slot.

The result preserves `requestId`, optional `dispatchId`, `provider`, `model`,
`stopReason` (`stop`, `error`, or `aborted`), native `answers`, and available
`usage`. Provider errors return safe generic messages; no native error, timeout,
abort, or uncertain response is converted to successful empty answers or retried
through a legacy client. Product-specific probability/route validation remains
with the existing product adapter. An unsupported older Host can be detected
before sending; this capability alone does not install or activate a new payload.

`classification.abort` signals only the exact active classification ID. Supplying
`dispatchId` also compares the original dispatch and rejects a replacement with
`CLASSIFICATION_TARGET_MISMATCH`. Active duplicates reject with
`CLASSIFICATION_ALREADY_ACTIVE`; IDs may be reused after settlement. Legacy
callers without `dispatchId` retain request-ID-only behavior. The abort result's
`aborted` means signal requested, `active` means the target was found, and
`drained` proves the native operation exited within the bounded wait. Unknown IDs
return all three values false. A non-cooperative request stays active after an
undrained cancellation; it cannot be replayed while its outcome is unknown.

Only after its provider operation exits and original RunScope settles does the
Host emit `runtime.notice` with `payload.type: classification_settled`, original
request/dispatch IDs, and `stopReason`. Paired clients bind this notice to the
original Host connection and dispatch, so a lost RPC reply can settle without
releasing a newer call. Classification, stateless completion, and Session Stop
have separate identity maps and never cancel one another.

## Stable prompt prefix and discovery

### Native MCP execution policy

Managed clients send `nativeMcpExecutionAllowed` on `session.open`, `tools.sync`,
and `session.fork` (the target Session's current policy). Missing values deny.
The host advertises `nativeMcpExecutionPolicy`; PAW requires that capability for
restricted Sessions rather than letting older hosts ignore their policy.

PAW grants native MCP only to its existing explicit unrestricted profiles.
Read-only, scoped, and memory-curation profiles retain governed Gateway tools
but cannot launch native MCP servers or call their tools/resources. Server
annotations such as `readOnlyHint` are advisory, not authorization. This is a
coarse native-MCP boundary until per-tool effects can use the product Gateway.

Policy refresh occurs between turns through `tools.sync`. A changed policy
reloads native registrations; execution and transport creation recheck the
current policy, so stale direct, deferred, and codemode references cannot
restore a revoked grant. Plugin reloads preserve the effective policy.

Each Classic Session starts with one deterministic model-facing prefix:

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
`tool_load` emits upstream Pi's `addedToolNames`, allowing native deferred tools
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

Classic Session memory and one-turn retrieval context remain product-owned. They are
injected through `before_agent_start` and are not stored as fake user messages.
After compaction, the integration refreshes the product Session context but does
not mutate Pi's authoritative `session_compact` settlement. The refreshed
context is composed during the next normal provider start. Compaction failures
and aborts are reported through Pi's `session_compact_failed` lifecycle
event and enter the same durable product outbox.

Classic conversation branches use `session.fork.candidates` and `session.fork`. The
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
stateless completions/classification, bounded native CodeMode models, and concurrency behavior.
