# PAW Subagent

An optional Pi Package that delegates bounded tasks to isolated Pi child
processes. It adds one `subagent` tool and a `/subagents` help command.

Responsibilities (`research`, `review`, and `execute`) are execution policies,
not personas. No character or assistant identity is injected.

## Install in Pi TUI

```bash
pi install ./integrations/rag-ime-runtime-host/pi-packages/subagent
```

The child uses its own configured default model unless the tool call explicitly
provides a model. This avoids copying a parent-only model alias into a child
Provider configuration that may not support it.

Limits:

- at most 8 tasks per call;
- at most 4 child processes concurrently;
- default timeout 5 minutes per child, maximum 30 minutes;
- parent-visible output capped at 50 KiB per child;
- captured details capped at 256 KiB per child;
- parent cancellation terminates the child process group.

Disable or remove it with Pi's native Package configuration:

```bash
pi config
pi remove @paw/pi-subagent
```
