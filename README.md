# cook

`cook` is a shell-native micro agent that runs natural-language tasks using Bun + Vercel AI SDK 6 `ToolLoopAgent`.

## Install

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/devadutta/cook/main/install.sh | sh
```

You can also host the same script on your own domain and keep the same pattern:

```bash
curl --proto '=https' --tlsv1.2 -LsSf <your-install-script-url> | sh
```

Installer overrides:

```bash
# install a specific release tag
curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/devadutta/cook/main/install.sh | COOK_VERSION=v0.1.0 sh

# install to a custom bin directory
curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/devadutta/cook/main/install.sh | COOK_INSTALL_DIR="$HOME/bin" sh
```

## Setup

```bash
bun install
bun run build:compile
```

You can also store keys in config files instead of exporting env vars.

Build outputs in `./dist`:

- `dist/cook.js` from `bun run build` (bundled Bun entry, requires Bun runtime)
- `dist/cook` from `bun run build:compile` (native standalone binary for current host target)

Release outputs in `./dist/release`:

- `cook-darwin-arm64`
- `cook-darwin-x64`
- `cook-linux-x64`

Initialize config using the binary you run:

```bash
./dist/cook config init
```

## Usage

```bash
# unquoted natural-language instruction
cook find all python files older than 2 months

# quoted still works (recommended for complex shell chars)
cook "find all python files older than 2 months"
cat filelist.txt | cook "rename these to match format file_date_extension"
cook config init
cook config init --global
cook config init --global --local --force
```

`cook` now accepts unknown `--tokens` inside unquoted instructions (for example: `cook find --older-than 60d --dry-run`, where `--dry-run` is still parsed as a cook option).

Pick an agent per run with `--agent <name>`:

```bash
cook --agent fast "scan this repo and summarize risks"
```

Command aliases:

```bash
# resolves create-pr.md and runs its contents as the instruction
cook /create-pr
```

Alias lookup rules:

- Alias form must be exactly `/name` (single token).
- Exact filename match only: `/name` maps to `name.md`.
- Search precedence: `cook` > `cursor` > `claude` > `codex`.
- Within each provider, local path is checked before home path.

Lookup paths:

- Cook: `./.cook/commands`, `~/.cook/commands`
- Cursor: `./.cursor/commands`, `~/.cursor/commands`
- Claude: `./.claude/commands`, `~/.claude/commands`
- Codex: `./.codex/commands`, `~/.codex/commands`

Compatibility fallbacks are also checked: `./.cook/commnds`, `./.codex/commads`, `~/.codex/commads`.

Output controls:

```bash
# default: human-friendly status/progress on stderr
cook "summarize this repo"

# suppress status/progress (keeps final stdout output and errors)
cook --quiet "summarize this repo"

# show detailed debug logs on stderr
cook --debug "summarize this repo"

# deprecated alias for --debug
cook --verbose "summarize this repo"

# enable raw bash terminal output mode for this run
cook --raw "find my DNS"
```

Session logs:

- Set `"session_logs": true` in config to record detailed run logs under `~/.cook/sessions/<UUID>/`.
- Logs include `session.json` metadata and append-only `events.jsonl` entries for session lifecycle, run lifecycle, agent call lifecycle, tool calls, and confirmation decisions.
- When enabled, logs include full prompt payloads (including resolved system prompt and composed instructions) for each agent run.

Session visualization:

- Generate a static visual report with `session.html` in session folders.
- `bun run share` defaults to the latest session.
- `bun run share -- latest` explicitly targets the latest session.
- `bun run share -- <session_id>` targets a single session.
- `bun run share:all` generates `session.html` for every valid session in `~/.cook/sessions/`.

## Safety

- Mutating actions (`Write`, `Edit`, mutating `Bash`) require confirmation by default.
- Bash mutation confirmation uses the model-provided `isMutating` flag (strictly no regex fallback).
- For Bash, `isMutating` should be `true` only for task-impacting state changes and `false` for read-only or ephemeral scratch effects (for example redirecting output to `/dev/null` or temporary files).
- Confirmation prompt supports `y/yes`, `n/no` (or empty Enter), `a/all`, or free-text guidance.
- `a/all` approves the current mutation and all future mutation prompts in the same run.
- Free-text guidance denies the current pending mutation batch.
- Guidance is injected into continuation messages as an explicit user correction for the rest of the run.
- Denied actions should be revised to match the guidance, not retried unchanged.
- Skip confirmation with `--yes`.
- Use `--dry-run` to preview mutating actions without executing them.
- File access is scoped to current directory by default.
- Use `--allow-outside-cwd` to lift path scope restrictions.
- Raw Bash terminal output mode is disabled by default.
- Enable raw mode with `--raw` (current run only) or `agents.<name>.raw_bash_output: true` in config.
- When raw mode is disabled, any `isFinal` input is ignored.
- When raw mode is enabled and `isFinal: true` with Bash exit code `0`, cook short-circuits and writes raw `stdout` (fallback `stderr`) directly to final `stdout` without an extra model summarization step.

## Config

- Global: `~/.cook/config.json`
- Local override: `.cook/config.json`
- Precedence: flags > local > global > defaults

Initialize a template:

```bash
# default local ./.cook/config.json
cook config init

# global config
cook config init --global

# both files, overwrite if they already exist
cook config init --global --local --force
```

### Example config

```json
{
  "max_steps": 12,
  "bash_timeout_ms": 30000,
  "bash_output_limit_bytes": 1048576,
  "stdin_inline_max_bytes": 65536,
  "require_confirm_mutations": true,
  "allow_outside_cwd": false,
  "quiet": false,
  "debug": false,
  "session_logs": false,
  "ai_gateway_api_key": "vercel-ai-gateway-key",
  "provider_api_keys": {
    "OPENAI_API_KEY": "openai-key",
    "ANTHROPIC_API_KEY": "anthropic-key",
    "GOOGLE_GENERATIVE_AI_API_KEY": "google-key",
    "GROQ_API_KEY": "groq-key"
  },
  "default_agent": "default",
  "agents": {
    "default": {
      "provider": "gateway",
      "model": "google/gemini-3-flash-preview",
      "raw_bash_output": false,
      "prompt_files": {
        "system_append": [
          ".cook/PROMPT_APPEND.md"
        ]
      },
      "ignore_agents_md": false
    },
    "fast": {
      "provider": "groq",
      "model": "llama-3.3-70b-versatile",
      "structured_output": false
    }
  }
}
```

Notes:

- This schema is snake_case only.
- `agents` supports providers: `gateway`, `google`, `anthropic`, `openai`, `groq`.
- `structured_output` is accepted for backward compatibility but is currently a no-op.
- If `--agent` is omitted, `default_agent` is used. If `default_agent` is unset, cook falls back to an agent named `default`.
- Built-in fallback `default` agent is portable: when it is unchanged from built-in defaults, cook auto-selects provider/model by available credentials in this precedence:
  `AI_GATEWAY_API_KEY` -> `gateway` + `google/gemini-3-flash-preview`,
  `OPENAI_API_KEY` -> `openai` + `gpt-5.2`,
  `ANTHROPIC_API_KEY` -> `anthropic` + `claude-sonnet-4-6`,
  `GOOGLE_GENERATIVE_AI_API_KEY` -> `google` + `gemini-3-flash-preview`,
  `GROQ_API_KEY` -> `groq` + `moonshotai/kimi-k2-instruct-0905`.
  This does not override a user-customized `agents.default`.
- `raw_bash_output` defaults to `false` per agent. `--raw` overrides it to `true` for the current run.
- Default status/progress output is written to `stderr`; final assistant response is written to `stdout`.
- `--quiet` suppresses status/progress output only.
- `--debug` enables detailed debug logs on `stderr`.
- `--verbose` is supported as a deprecated alias for `--debug`.
- `session_logs` defaults to `false`; when enabled, detailed logs are written to `~/.cook/sessions/<UUID>/`.
- `ai_gateway_api_key` is used when an agent provider is `gateway`.
- `provider_api_keys` entries are exported to process environment variables at startup.

## System Prompt Files

System prompt composition order:

1. Base built-in cook instructions.
2. System body:
   - If selected agent sets `prompt_files.system`, that file is used (resolved from current working directory).
   - Else use `./.cook/prompts/SYSTEM.md` if present.
   - Else use `./.cook/SYSTEM.md` if present (legacy fallback).
3. Append files from `prompt_files.system_append` in listed order (resolved from current working directory).
4. Append cwd context files in fixed order, when present: `AGENTS.md`, `CLAUDE.md`, `cook.md`.

`ignore_agents_md: true` on an agent skips `AGENTS.md` and `CLAUDE.md`, but still appends `cook.md`.

## Development

```bash
bun test
bun run typecheck
bun run build
bun run build:compile
bun run release
```

## Versioning And Releases

- `cook --version` is sourced from `package.json` (`version` field).
- Version bumping is automated by GitHub `release-please` on `main`:
  it opens a release PR that updates `package.json`; merging that PR creates the GitHub Release/tag.
- Release artifacts are automated on GitHub Release `published` events:
  binaries for macOS arm64, macOS x64, and Linux x64 are built and uploaded to the release.
- The release workflow validates `tag == v<package.json version>` before uploading assets.
