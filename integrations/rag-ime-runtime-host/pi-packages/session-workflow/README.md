# PAW Session Workflow

An optional Pi Package for Session-local Goal, Plan, Todo, and Workflow state.

It does not install a persona and does not introduce a second agent loop. Pi
continues to own the Session, model call, tool loop, context, compaction,
cancellation, and TUI.

## Install in Pi TUI

From the Pi repository checkout:

```bash
pi install ./integrations/rag-ime-runtime-host/pi-packages/session-workflow
```

Then use:

- `/goal <objective>` to set the current Goal;
- `/goal pause`, `/goal resume`, or `/goal clear`;
- `/plan <step one>; <step two>` to set a Plan;
- `/todos` or `/workflow` to inspect current state;
- the `session_workflow` tool for model-driven state updates.

Disable or remove it through Pi's native Package configuration:

```bash
pi config
pi remove @paw/pi-session-workflow
```
