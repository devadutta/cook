<p align="center">
<pre>
                              oooo
                              `888
 .ooooo.   .ooooo.   .ooooo.   888  oooo
d88' `"Y8 d88' `88b d88' `88b  888 .8P'
888       888   888 888   888  888888.
888   .o8 888   888 888   888  888 `88b.
`Y8bod8P' `Y8bod8P' `Y8bod8P' o888o o888o
</pre>
</p>

<p align="center">
  <strong>A portable terminal AI agent that runs tasks in natural language.</strong><br/>
  One binary. No runtime. Works with any LLM provider.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#providers--models">Providers</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#configuration">Configuration</a>
</p>

---

## Why cook?

Most AI coding tools lock you into an editor, a specific model, or a subscription. **cook** is different:

- **Shell-native** — lives in your terminal, works with pipes, scripts, and cron jobs
- **Model-agnostic** — swap between OpenAI, Anthropic, Google, Groq, or Vercel AI Gateway with a flag
- **Single binary** — compiles to a standalone executable with zero runtime dependencies
- **Safe by default** — every file write and destructive command requires your approval
- **Extensible** — bring your own system prompts, command aliases, and agent configurations

```bash
# just talk to it
cook find all TODO comments in this repo and summarize them

# pipe data in
cat server.log | cook "find the root cause of the 502 errors"

# use command aliases
cook /create-pr
```

---

## Table of Contents

- [Quick Start](#quick-start)
- [Usage](#usage)
  - [Natural Language](#natural-language)
  - [Piped Input](#piped-input)
  - [Command Aliases](#command-aliases)
  - [Agents](#agents)
  - [Output Modes](#output-modes)
  - [Raw Terminal Mode](#raw-terminal-mode)
- [Providers & Models](#providers--models)
- [Safety](#safety)
- [Configuration](#configuration)
  - [Config Precedence](#config-precedence)
  - [Example Config](#example-config)
  - [System Prompt Composition](#system-prompt-composition)
- [Session Logs & Visualization](#session-logs--visualization)
- [CLI Reference](#cli-reference)
- [Installation](#installation)
  - [Install Script](#install-script)
  - [Build From Source](#build-from-source)
- [Development](#development)

---

## Quick Start

```bash
# install
curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/devadutta/cook/main/install.sh | sh

# set any provider key (pick one)
export ANTHROPIC_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."
export GOOGLE_GENERATIVE_AI_API_KEY="..."

# go
cook "explain what this project does"
```

cook auto-detects which API key you have and picks a sensible model. No config file required.

---

## Usage

### Natural Language

Just type what you want after `cook`. Quotes are optional — use them when your instruction contains special shell characters.

```bash
# unquoted works fine
cook find all python files older than 2 months

# quotes recommended for complex instructions
cook "find all *.py files modified before $(date -d '2 months ago' +%Y-%m-%d)"
```

cook has four built-in tools it can use to accomplish tasks:

| Tool | What it does |
|------|-------------|
| **Read** | Read files from disk |
| **Write** | Create or overwrite files (requires approval) |
| **Edit** | Find-and-replace edits applied atomically |
| **Bash** | Run shell commands with timeout and output limits |

### Piped Input

cook reads from stdin when data is piped in. Small inputs are inlined into the prompt; larger inputs are written to a temp file automatically.

```bash
cat filelist.txt | cook "rename these to kebab-case"
git diff HEAD~3 | cook "write a changelog entry for these changes"
ps aux | cook "which process is using the most memory and why?"
```

### Command Aliases

Save frequently used prompts as `.md` files and invoke them with `/name`:

```bash
cook /create-pr
cook /review-code
cook /fix-lint
```

This resolves `create-pr.md` from these directories (first match wins):

| Priority | Local | Home |
|----------|-------|------|
| 1 | `.cook/commands/` | `~/.cook/commands/` |
| 2 | `.cursor/commands/` | `~/.cursor/commands/` |
| 3 | `.claude/commands/` | `~/.claude/commands/` |
| 4 | `.codex/commands/` | `~/.codex/commands/` |

Local paths are always checked before home paths within each provider.

### Agents

Define multiple agent configurations with different providers and models. Switch between them per run:

```bash
# use the default agent
cook "summarize this repo"

# use a fast agent for quick tasks
cook --agent fast "what does main.ts export?"
```

Agents are defined in your config file — see [Configuration](#configuration).

### Output Modes

```bash
# default: status on stderr, final answer on stdout
cook "summarize this repo"

# quiet: suppress status, keep final output
cook --quiet "summarize this repo"

# debug: verbose logging on stderr
cook --debug "summarize this repo"

# combine with pipes — only the final answer goes to stdout
cook "list all exported functions" > functions.txt
```

### Raw Terminal Mode

When you want the raw output of a command instead of an AI summary:

```bash
cook --raw "find my public IP address"
# → directly prints the command output, no summarization step
```

Enable per-agent with `raw_bash_output: true` in config, or per-run with `--raw`.

---

## Providers & Models

cook works with multiple AI providers. Set the appropriate API key and cook picks the right one automatically.

| Provider | Environment Variable | Default Model |
|----------|---------------------|---------------|
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `google/gemini-3-flash-preview` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.2` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | `gemini-3-flash-preview` |
| Groq | `GROQ_API_KEY` | `moonshotai/kimi-k2-instruct-0905` |

**Auto-selection precedence** (when using the default agent): Gateway → OpenAI → Anthropic → Google → Groq.

You can also store keys in the config file instead of environment variables — see [Example Config](#example-config).

---

## Safety

cook is designed to be safe by default. You stay in control.

- **Mutation approval** — Write, Edit, and destructive Bash commands require confirmation before executing
- **Smart classification** — the model flags whether each command is mutating (no brittle regex matching)
- **Path scoping** — file access is restricted to the current directory by default
- **Dry-run mode** — preview what cook would do without making changes

When prompted for confirmation, you can respond with:

| Input | Effect |
|-------|--------|
| `y` / `yes` | Approve this action |
| `n` / `no` / Enter | Deny this action |
| `a` / `all` | Approve this and all future mutations in this run |
| *free text* | Deny and provide guidance to the agent |

```bash
# skip all confirmations (use with care)
cook --yes "update all imports in src/"

# preview mutations without executing
cook --dry-run "refactor the auth module"

# allow file operations outside cwd
cook --allow-outside-cwd "update ~/.bashrc"
```

---

## Configuration

### Config Precedence

Flags → Local config → Global config → Defaults

```bash
# create local config (.cook/config.json)
cook config init

# create global config (~/.cook/config.json)
cook config init --global

# both, overwriting existing files
cook config init --global --local --force
```

### Example Config

```json
{
  "max_steps": 12,
  "bash_timeout_ms": 30000,
  "bash_output_limit_bytes": 1048576,
  "require_confirm_mutations": true,
  "allow_outside_cwd": false,
  "quiet": false,
  "debug": false,
  "session_logs": false,
  "provider_api_keys": {
    "OPENAI_API_KEY": "sk-...",
    "ANTHROPIC_API_KEY": "sk-..."
  },
  "default_agent": "default",
  "agents": {
    "default": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "prompt_files": {
        "system_append": [".cook/PROMPT_APPEND.md"]
      }
    },
    "fast": {
      "provider": "groq",
      "model": "llama-3.3-70b-versatile"
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `max_steps` | `12` | Maximum tool-use iterations per run (1–100) |
| `bash_timeout_ms` | `30000` | Bash command timeout in ms (100–3,600,000) |
| `bash_output_limit_bytes` | `1048576` | Max captured bash output (1KB–20MB) |
| `stdin_inline_max_bytes` | `65536` | Stdin size before switching to temp file (1KB–5MB) |
| `require_confirm_mutations` | `true` | Require approval for file writes and destructive commands |
| `allow_outside_cwd` | `false` | Allow file operations outside the working directory |
| `quiet` | `false` | Suppress status/progress output |
| `debug` | `false` | Enable detailed debug logging |
| `session_logs` | `false` | Record session logs to `~/.cook/sessions/` |

**Agent-level options:**

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | auto | One of: `gateway`, `openai`, `anthropic`, `google`, `groq` |
| `model` | auto | Model identifier for the provider |
| `raw_bash_output` | `false` | Enable raw terminal output mode |
| `prompt_files.system` | — | Custom system prompt file |
| `prompt_files.system_append` | — | Additional prompt files appended in order |
| `ignore_agents_md` | `false` | Skip `AGENTS.md` and `CLAUDE.md` context files |

### System Prompt Composition

cook composes the system prompt in this order:

1. Built-in base instructions (host context, tools, safety rules)
2. **System body**: agent's `prompt_files.system` → `.cook/prompts/SYSTEM.md` → `.cook/SYSTEM.md`
3. **Append files**: each file in `prompt_files.system_append`, in order
4. **Context files**: `AGENTS.md`, `CLAUDE.md`, `cook.md` (auto-discovered in cwd)

Set `ignore_agents_md: true` on an agent to skip `AGENTS.md` and `CLAUDE.md` (still includes `cook.md`).

---

## Session Logs & Visualization

Enable `session_logs: true` in config to record detailed run history.

```
~/.cook/sessions/<uuid>/
├── session.json       # metadata (time, agent, provider, model, args)
└── events.jsonl       # append-only event stream
```

Events cover the full lifecycle: session start/finish, agent runs, tool calls, confirmation decisions, and complete prompt payloads.

**Generate a visual report:**

```bash
bun run share              # latest session
bun run share -- <id>      # specific session
bun run share:all          # all sessions
```

This creates a `session.html` file you can open in any browser.

---

## CLI Reference

```
cook [options] <instruction>
cook config init [--global] [--local] [--force]
cook /alias-name
```

| Flag | Description |
|------|-------------|
| `-y`, `--yes` | Skip all confirmation prompts |
| `--quiet` | Suppress status/progress output |
| `--debug` | Enable detailed debug logs |
| `--verbose` | Alias for `--debug` |
| `--agent <name>` | Select a configured agent |
| `--max-steps <n>` | Override max tool iterations |
| `--timeout <ms>` | Override bash command timeout |
| `--allow-outside-cwd` | Allow file access outside working directory |
| `--dry-run` | Preview mutations without executing |
| `--raw` | Enable raw bash terminal output |
| `-V`, `--version` | Print version and exit |

---

## Installation

### Install Script

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/devadutta/cook/main/install.sh | sh
```

**Options:**

```bash
# specific version
curl ... | COOK_VERSION=v0.1.0 sh

# custom install directory
curl ... | COOK_INSTALL_DIR="$HOME/bin" sh
```

Pre-built binaries are available for:

| Platform | Architecture |
|----------|-------------|
| macOS | arm64, x64 |
| Linux | arm64, x64, x64-baseline, x64-musl |
| Windows | x64 |

### Build From Source

```bash
git clone https://github.com/devadutta/cook.git
cd cook
bun install
bun run build:compile    # → dist/cook (standalone binary)
```

---

## Development

```bash
bun install              # install dependencies
bun test                 # run tests
bun run typecheck        # type-check without emitting
bun run build            # bundle → dist/cook.js (needs Bun runtime)
bun run build:compile    # compile → dist/cook (standalone binary)
bun run release          # build all platform binaries → dist/release/
```

Versioning is automated via [release-please](https://github.com/googleapis/release-please) on the `main` branch.

---

<p align="center">
  <sub>Built with <a href="https://bun.sh">Bun</a> and the <a href="https://sdk.vercel.ai">Vercel AI SDK</a>.</sub>
</p>
