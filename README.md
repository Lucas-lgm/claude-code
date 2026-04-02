# Claude Code Source - Buildable Research Fork

> A **buildable, modifiable, and runnable** version of the Claude Code source.

Based on the Claude Code source snapshot publicly exposed on 2026-03-31 via an npm source map leak. The original snapshot contained only raw TypeScript source with no build configuration — it could not be compiled or run. This fork reconstructs the full build system and fixes all missing components to make it functional.

---

## What Changed vs. the Original Snapshot

The original snapshot shipped **no `package.json`, no `tsconfig.json`, no lockfile, and no build scripts**. Over 100 internal/feature-gated modules were also missing from the source map.

### Build System (Reconstructed)

| File | Purpose |
|------|---------|
| `package.json` | 60+ npm dependencies reverse-engineered from ~1,900 source files |
| `tsconfig.json` | TypeScript config (ESNext + JSX + Bun bundler resolution) |
| `bunfig.toml` | Bun runtime configuration |
| `.gitignore` | Excludes `node_modules/`, `dist/`, lockfiles |

### Stub Modules (Created)

The original source imports many Anthropic-internal packages and feature-gated modules that were not included in the leak. Minimal stubs were created so the build completes:

| Category | Count | Examples |
|----------|-------|---------|
| Anthropic internal packages (`@ant/*`) | 4 | computer-use-mcp, computer-use-swift, claude-for-chrome-mcp |
| Native addons | 3 | color-diff-napi, audio-capture-napi, modifiers-napi |
| Cloud provider SDKs | 6 | Bedrock/Foundry/Vertex SDK, AWS STS, Azure Identity |
| OpenTelemetry exporters | 10 | OTLP gRPC/HTTP/Proto exporters |
| Other optional packages | 2 | sharp, turndown |
| Feature-gated source modules | ~90 | Tools, commands, services, components excluded from the source map |

### Source Fixes

| File | Change |
|------|--------|
| `src/main.tsx` | Runtime `MACRO` constant injection (compile-time define in production) |
| `src/main.tsx` | Fixed Commander.js `-d2e` short flag incompatibility |
| `src/bootstrap/state.ts` | Added missing `isReplBridgeActive()` export |
| `src/types/connectorText.ts` | Added `isConnectorTextBlock` function stub |
| `src/tools/WorkflowTool/constants.ts` | Added `WORKFLOW_TOOL_NAME` export |
| `node_modules/bundle/` | Runtime polyfill for `bun:bundle` feature flag system |

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.3.x
- Valid Anthropic authentication (OAuth via `claude login` or `ANTHROPIC_API_KEY`)

### Install & Build

```bash
git clone https://github.com/beita6969/claude-code.git
cd claude-code

# Install dependencies
bun install

# Build (produces dist/main.js, ~20MB)
bun build src/main.tsx --outdir=dist --target=bun
```

### Run

```bash
# Headless print mode (no TTY needed)
bun src/main.tsx -p "your prompt here" --output-format text

# JSON output
bun src/main.tsx -p "your prompt here" --output-format json

# Interactive REPL mode (needs TTY)
bun src/main.tsx
```

> **Note**: If `ANTHROPIC_API_KEY` is set in your environment, it must be valid. To use OAuth instead, unset it:
> ```bash
> unset ANTHROPIC_API_KEY
> ```

---

## Architecture Overview

```
src/
├── main.tsx              # CLI entrypoint (Commander.js + React/Ink)
├── QueryEngine.ts        # Core LLM API engine
├── query.ts              # Agentic loop (async generator)
├── Tool.ts               # Tool type definitions
├── tools.ts              # Tool registry
├── commands.ts           # Command registry
├── context.ts            # System prompt context
│
├── tools/                # 40+ tool implementations
│   ├── AgentTool/        # Sub-agent spawning & coordination
│   ├── BashTool/         # Shell command execution
│   ├── FileReadTool/     # File reading
│   ├── FileEditTool/     # File editing
│   ├── GrepTool/         # ripgrep-based search
│   ├── MCPTool/          # MCP server tool invocation
│   ├── SkillTool/        # Skill execution
│   └── ...
│
├── services/             # External integrations
│   ├── api/              # Anthropic API client
│   ├── mcp/              # MCP server management
│   └── ...
│
├── memdir/               # Persistent memory system
├── skills/               # Skill system (bundled + user)
├── components/           # React/Ink terminal UI
├── hooks/                # React hooks
├── coordinator/          # Multi-agent orchestration
└── stubs/                # Stub packages for missing internals
```

### Key Systems

| System | Files | Description |
|--------|-------|-------------|
| **Agentic Loop** | `query.ts`, `QueryEngine.ts` | `while(true)` async generator: query -> tool calls -> results -> loop |
| **Memory** | `memdir/` | 4-type file-based memory (user/feedback/project/reference) with MEMORY.md index |
| **MCP** | `services/mcp/` | Model Context Protocol server management (stdio/http/sse/ws) |
| **Skills** | `skills/`, `tools/SkillTool/` | Reusable workflow templates (SKILL.md format) |
| **Agents** | `tools/AgentTool/` | Custom agent types via `.claude/agents/*.md` |
| **System Prompt** | `constants/prompts.ts` | Layered prompt: static -> dynamic -> memory -> agent |

### Extension Points (No Source Modification Needed)

| Mechanism | Location | Format |
|-----------|----------|--------|
| Custom Skills | `.claude/skills/name/SKILL.md` | YAML frontmatter + Markdown |
| Custom Agents | `.claude/agents/name.md` | YAML frontmatter + Markdown |
| MCP Servers | `.mcp.json` | JSON config |
| Hooks | `~/.claude/settings.json` | JSON event-action mappings |

---

## Feature Flags

The `bun:bundle` `feature()` function controls feature gating. In this build, all features default to **disabled**. To enable features, edit `node_modules/bundle/index.js`:

```javascript
const ENABLED_FEATURES = new Set([
  // Uncomment to enable:
  // 'KAIROS',              // Assistant mode
  // 'PROACTIVE',           // Proactive mode
  // 'BRIDGE_MODE',         // IDE bridge
  // 'VOICE_MODE',          // Voice input
  // 'COORDINATOR_MODE',    // Multi-agent coordinator
  // 'EXTRACT_MEMORIES',    // Background memory extraction
  // 'TEAMMEM',             // Team memory
])
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Language | TypeScript (strict) |
| Terminal UI | React + Ink |
| CLI | Commander.js |
| Validation | Zod v4 |
| Search | ripgrep |
| Protocols | MCP SDK, LSP |
| API | Anthropic SDK |
| Telemetry | OpenTelemetry |

---

## Scale

- **~1,900 source files**
- **512,000+ lines of TypeScript**
- **40+ tools**, **100+ commands**, **140+ UI components**
- **20MB** compiled bundle

---

## OpenAI Model Support

This fork supports using OpenAI models (GPT-5.4, o3, o4-mini, etc.) as a drop-in replacement for Claude models. The adapter translates between Anthropic SDK format and OpenAI Chat Completions format transparently.

### Quick Start

**Method 1: API Key (Simplest)**

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-proj-xxx

# Use specific model
bun src/main.tsx --model gpt-5.4 -p "your prompt"

# Use alias
bun src/main.tsx --model gpt -p "your prompt"

# Use reasoning model
bun src/main.tsx --model o3 -p "your prompt"
```

**Method 2: OAuth Login (ChatGPT Account)**

```bash
export CLAUDE_CODE_USE_OPENAI=1

# Trigger OAuth login — opens browser for ChatGPT sign-in
# Token is stored at ~/.claude/.openai-auth.json and auto-refreshes
bun src/main.tsx --model gpt-5.4
```

The OAuth flow uses the same PKCE protocol as OpenAI's Codex CLI (client ID `app_EMoamEEZ73f0CkXaXp7hrann`).

**Method 3: Compatible API (Third-Party / Proxy / Self-Hosted)**

Any service that implements the OpenAI `/v1/chat/completions` endpoint can be used as a backend.

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-key
export OPENAI_BASE_URL=https://your-api-endpoint.com/v1

bun src/main.tsx --model gpt-5.4 -p "your prompt"
```

Common compatible services:

| Service | Example `OPENAI_BASE_URL` | Notes |
|---------|---------------------------|-------|
| OpenAI Official | (leave unset) | Default `https://api.openai.com/v1` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai/deployments/{deployment}` | Use Azure API key |
| vLLM | `http://localhost:8000/v1` | Local model serving |
| Ollama | `http://localhost:11434/v1` | Local models via Ollama |
| LiteLLM | `http://localhost:4000/v1` | Multi-provider proxy |
| OpenRouter | `https://openrouter.ai/api/v1` | Model routing service |
| Custom Proxy | `https://your-proxy.com/v1` | Any OpenAI-compatible relay |

> **Requirements**: The backend must support streaming (`stream: true`), `stream_options.include_usage`, and the tool/function calling protocol. The `--model` value is passed directly to the backend as-is — use whatever model name your service expects.

### Supported Models

| Model | Alias | Type | Context Window |
|-------|-------|------|----------------|
| `gpt-5.4` | `gpt` | Flagship | 256K |
| `gpt-5.4-mini` | — | Fast | 256K |
| `gpt-5.4-nano` | — | Lightweight | 128K |
| `gpt-5.3` | — | Previous gen | 256K |
| `o3` | `o3` | Reasoning | 200K |
| `o3-pro` | — | Max reasoning | 200K |
| `o4-mini` | — | Fast reasoning | 200K |
| `gpt-4o` | — | Legacy (API only) | 128K |
| `gpt-4.1` | — | Legacy (API only) | 1M |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_USE_OPENAI` | Yes | Set to `1` to enable OpenAI mode |
| `OPENAI_API_KEY` | Yes* | OpenAI API key. Not required if using OAuth. |
| `OPENAI_BASE_URL` | No | Custom API endpoint for compatible APIs |
| `OPENAI_USE_CHAT_COMPLETIONS` | No | Set to `1` to use legacy `/v1/chat/completions` instead of `/v1/responses` |
| `ANTHROPIC_MODEL` | No | Override default model (e.g., `gpt-5.4`) |

### API Mode

The adapter supports two OpenAI API formats:

| Mode | Endpoint | Default | Env Override |
|------|----------|---------|-------------|
| **Responses API** | `/v1/responses` | Yes (default) | — |
| **Chat Completions** | `/v1/chat/completions` | No | `OPENAI_USE_CHAT_COMPLETIONS=1` |

The **Responses API** is OpenAI's newer format used by GPT-5.x and Codex. Most modern proxies and OpenAI-compatible services support this format. If your service only supports the legacy Chat Completions format (e.g., older vLLM, Ollama), set `OPENAI_USE_CHAT_COMPLETIONS=1`.

### Feature Compatibility

| Feature | Status | Notes |
|---------|--------|-------|
| Text generation | Full | All models |
| Tool use / Function calling | Full | All models |
| Streaming | Full | All models |
| Image input (vision) | Full | base64 and URL formats |
| Reasoning (thinking) | Partial | o3/o4-mini via `reasoning_effort: high` |
| Prompt caching | N/A | OpenAI has no equivalent; annotations ignored |
| Extended thinking | N/A | Anthropic-specific; disabled for OpenAI |
| Web search (server tool) | N/A | Anthropic-specific |

### How It Works

The adapter (`src/services/api/openai-adapter.ts`) creates a fake Anthropic SDK client that:

1. Converts Anthropic message format → OpenAI Chat Completions format
2. Translates tool schemas (Anthropic `input_schema` → OpenAI `parameters`)
3. Streams OpenAI `ChatCompletionChunk` events → Anthropic `BetaRawMessageStreamEvent`
4. Maps stop reasons (`stop` → `end_turn`, `tool_calls` → `tool_use`)
5. Wraps OpenAI errors into Anthropic SDK error types

The rest of the codebase works unchanged — it only sees the Anthropic SDK interface.

---

## Disclaimer

- This repository is for **educational and research purposes only**.
- The original Claude Code source is the property of **Anthropic**.
- This repository is **not affiliated with, endorsed by, or maintained by Anthropic**.
- Original source exposure: 2026-03-31 via npm source map leak.
