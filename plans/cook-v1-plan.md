# Cook v1 Plan

## Summary
Build `cook` as a Bun-based shell-native micro agent that executes natural-language instructions using Vercel AI SDK 6 `ToolLoopAgent` and AI Gateway. The tool surface is intentionally minimal: `Read`, `Write`, `Edit`, `Bash`.

## Core Requirements
1. Runtime/package manager: Bun.
2. Agent stack: `ai@6` with `ToolLoopAgent`.
3. Provider: `@ai-sdk/gateway` in v1.
4. Pipeline support via stdin (`cat input | cook "..."`).
5. Tool surface: only `Read`, `Write`, `Edit`, `Bash`.

## CLI Behavior
- Command: `cook "<instruction>"`
- Supports piped stdin.
- Defaults to one confirmation gate before mutating actions.
- `--yes` bypasses confirmation.
- `--dry-run` plans mutating actions and executes none.
- Result-only output goes to stdout; diagnostics go to stderr.

## Safety Defaults
- Workspace path scope restricted to current directory tree.
- `--allow-outside-cwd` disables path restriction.
- Bash runs with timeout and output-cap defaults.
- Non-interactive confirmation-required runs exit with a hint.

## Config
- Global: `~/.cook/config.json`
- Local override: `.cook/config.json`
- Precedence: CLI flags > local > global > defaults.

## Testing
- Unit tests for policy/path checks.
- Unit tests for edit find/replace behavior.
- Unit tests for config merge precedence.
