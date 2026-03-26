# Doc Guardian

**Doc Guardian** is a voice-first, repo-aware coding assistant for VS Code.
It combines:

- **ElevenLabs ElevenAgents (ConvAI)** for conversational reasoning
- **Firecrawl Search** for live documentation retrieval
- **In-editor monitoring** for proactive code risk alerts

Instead of breaking flow to open tabs, search docs, and stitch context manually, you can ask Doc Guardian directly while coding and get grounded, patch-oriented guidance in the same panel.

---

## What It Does

Doc Guardian is designed to feel like a coding copilot that stays inside your editor and keeps context over time.

### 1) Repo-aware assistant answers
When you ask a question, Doc Guardian can provide context from:

- Active file
- Visible editors
- Selected code
- Nearby code around cursor
- Diagnostics (errors/warnings)
- Monitor findings
- Files mentioned in your prompt (`src/App.tsx`, `server/index.ts`, `package.json`, etc.)

### 2) Firecrawl-powered docs search
The assistant uses Firecrawl to fetch live docs/search results and surfaces relevant references directly in the panel.

### 3) Persistent project context + sessions
Per workspace, Doc Guardian stores:

- Project context (name, stack, summary, docs URLs)
- Multiple sessions
- Session turns
- Recent docs lookups

You can switch sessions anytime without losing project grounding.

### 4) Background monitor + proactive alerts
Doc Guardian continuously analyzes active/changed files and flags risky patterns and diagnostics.
When issues appear, it can auto-fetch related docs in the background and show alert suggestions.

### 5) Voice workflow
- **Voice input** via in-panel dictation (when runtime supports Web Speech APIs)
- **Voice output** via ElevenLabs TTS (assistant replies are spoken when enabled)

### 6) Reconnect-safe ConvAI flow
If ConvAI drops, Doc Guardian reconnects, re-syncs context, and retries the turn to preserve continuity.

---

## Architecture

```text
VS Code Webview Panel
  ├─ User question / dictation
  ├─ Live docs + monitor UI
  └─ Audio playback

VS Code Extension Host (TypeScript)
  ├─ ConvaiService (@elevenlabs/client, websocket text session)
  ├─ DocSearchService (Firecrawl v2 search API)
  ├─ CodeMonitorService (rules + diagnostics)
  ├─ SessionStore (workspace context + sessions)
  └─ VoiceService (ElevenLabs TTS)

External APIs
  ├─ ElevenLabs ConvAI agent
  ├─ ElevenLabs TTS
  └─ Firecrawl Search API
```

---

## ConvAI Tooling Contract

Your ElevenLabs agent should call these **client tools** (implemented by the extension):

1. `get_code_context`
2. `search_docs`
3. `get_monitor_findings_v5`

No additional backend is required for these tools.

### `get_code_context`
Returns JSON with:
- file path
- language
- selected code
- surrounding code
- diagnostics
- referenced files
- monitor findings

### `search_docs`
Accepts query-like input and returns:
- query
- structured results (`title`, `url`, `snippet`, `source`)

### `get_monitor_findings_v5`
Returns:
- findings with severity/file/line/rule/source
- counts including high-severity count

---

## Commands

- `Doc Guardian: Open Assistant`
- `Doc Guardian: Search Docs`
- `Doc Guardian: Ask About Selection`
- `Doc Guardian: Set Project Context`
- `Doc Guardian: New Session`
- `Doc Guardian: Switch Session`

---

## Quick Start (User)

1. Install extension and open your repo in VS Code.
2. Run `Doc Guardian: Open Assistant`.
3. Click **Set Context** and save project details.
4. Ask questions in text or use **Dictate**.
5. Use **Search Docs** for explicit docs retrieval.
6. Let background monitor surface findings and related docs automatically.

---

## Installation

## Option A: Install from Marketplace
Install `Doc Guardian` from VS Code Extensions panel.

## Option B: Install from VSIX
```bash
code --install-extension doc-guardian-0.1.4.vsix --force
```

## Option C: Local Development
```bash
npm install
npm run compile
```
Then press `F5` in VS Code to launch Extension Development Host.

---

## Configuration

All settings are under `docGuardian.*`:

- `docGuardian.firecrawlApiKey`  
  Firecrawl API key for live docs search.

- `docGuardian.elevenLabsApiKey`  
  ElevenLabs API key used for TTS and signed ConvAI URL flow.

- `docGuardian.elevenLabsVoiceId`  
  Voice ID for spoken assistant replies.

- `docGuardian.elevenLabsAgentId`  
  Agent ID for ElevenLabs ConvAI session.

- `docGuardian.autoSpeakResponses` (default: `true`)  
  Speak assistant responses automatically.

- `docGuardian.maxDocsPerSearch` (default: `5`)  
  Max results returned from docs search.

- `docGuardian.enableLiveMonitoring` (default: `true`)  
  Enable live code monitor.

- `docGuardian.monitorDebounceMs` (default: `1200`)  
  Debounce for monitor checks.

- `docGuardian.showPopupsForAlerts` (default: `true`)  
  Show warning/info popups for alerts.

- `docGuardian.enableBackgroundDocWatch` (default: `true`)  
  Monitor active file and fetch docs in background.

- `docGuardian.backgroundDocWatchDebounceMs` (default: `4500`)
- `docGuardian.backgroundDocWatchMinIntervalMs` (default: `90000`)

- `docGuardian.enableWorkspaceBackgroundDocWatch` (default: `true`)  
  Monitor changed files across workspace (low-priority path).

- `docGuardian.workspaceBackgroundDocWatchDebounceMs` (default: `12000`)
- `docGuardian.workspaceBackgroundDocWatchMinIntervalMs` (default: `180000`)

---

## What The Monitor Checks

Rules include:

- Broad `any` usage
- `@ts-ignore`
- `console.log(...)`
- `TODO` / `FIXME`
- `eval(...)`
- VS Code diagnostics (errors/warnings)
- Very large file warning (`> 800` lines)

Findings are deduplicated and capped per file for signal quality.

---

## Session & Context Persistence

Stored in VS Code `globalState` per workspace:

- Project context
- Session list
- Active session ID
- Turns (capped)
- Doc lookups (capped)

This enables continuity across restarts and session switches.

---

## Troubleshooting

## "ConvAI disconnected"
Doc Guardian auto-reconnects and retries once. If it persists:
- verify `docGuardian.elevenLabsAgentId`
- verify agent/tool config in ElevenLabs dashboard

## "ElevenLabs TTS failed (401)"
Usually quota/credits issue or invalid API key.
- confirm key in settings
- check ElevenLabs billing/credits

## Dictation button does nothing
Speech recognition depends on webview runtime support.
Use text input if unavailable.

## "command 'docGuardian.openAssistant' not found"
Reload and reinstall latest extension build:
- `Developer: Reload Window`
- reinstall latest VSIX/Marketplace version

---

## Security Notes

- Do **not** commit private keys to public repos.
- Prefer VS Code settings/secrets or environment-based injection for production.
- Keep Firecrawl and ElevenLabs keys rotated for shared/public builds.

---

## Build & Publish

### Build
```bash
npm run compile
```

### Lint
```bash
npm run lint
```

### Package VSIX
```bash
npx @vscode/vsce package
```

### Publish to Marketplace
```bash
npx @vscode/vsce publish
```

Requirements:
- Azure DevOps PAT with Marketplace publish scope
- Correct `publisher` in `package.json`

---

## Tech Stack

- TypeScript
- VS Code Extension API
- ElevenLabs `@elevenlabs/client` (ConvAI)
- ElevenLabs TTS REST API
- Firecrawl Search API v2
- Node `ws`

---

## Status

Current packaged release line: **0.1.4**

Key recent reliability improvements:
- reconnect-safe ask flow
- context re-sync on reconnect
- improved handling of post-reconnect greeting noise

---

## License

MIT
