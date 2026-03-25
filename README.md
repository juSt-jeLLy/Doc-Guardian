# Doc Guardian (VS Code Extension)

Doc Guardian is a coding-side assistant powered by your ElevenLabs ConvAI agent.

1. **Ask while coding** in a dedicated chat panel.
2. **Search docs** for APIs/libraries from the command palette.
3. **Live code monitoring** for risky patterns and diagnostics.
4. **Voice mode** with dictation + spoken responses.
5. **Background docs watch** that alerts automatically when active-file issues appear.

## Features

- `Doc Guardian: Open Assistant`
  - Opens the chat panel.
- `Doc Guardian: Search Docs`
  - Searches web docs (Firecrawl) and shows top references.
- `Doc Guardian: Ask About Selection`
  - Uses current code selection as context.
- `Doc Guardian: Set Project Context`
  - Auto-derives repo hints (name/stack/summary), lets you add docs URLs, then saves all for this workspace.
- `Doc Guardian: New Session`
  - Starts a fresh saved session while keeping project context.
- `Doc Guardian: Switch Session`
  - Re-open previous saved sessions for this workspace.
- Voice in panel:
  - `Dictate` button captures voice-to-text (when supported in runtime)
  - assistant replies are spoken automatically (ElevenLabs TTS + local fallback)
- Background docs watch:
  - continuously monitors active file diagnostics/findings
  - low-priority monitor for changed files across workspace
  - auto-searches docs relevant to file imports + active errors
  - shows alerts and pushes top docs without asking

ConvAI runtime flow:

- Extension opens a real text-only ConvAI session to your dashboard agent.
- Agent calls these client tools from the extension:
  - `get_code_context`
  - `search_docs`
  - `get_monitor_findings_v5`
- Tool results are returned to the agent, and agent replies are shown in panel + spoken.
- File-aware context is injected on asks:
  - active file + visible editors
  - files you mention in prompt (for example `src/app.ts`, `@server/index.ts`, `package.json`)
- Session memory is persisted:
  - project context per workspace
  - reference docs URLs per workspace context
  - turns history per session
  - docs lookups per session

Live monitor checks:

- `any` type usage
- `@ts-ignore`
- `console.log`
- `TODO/FIXME`
- `eval(...)`
- existing VS Code diagnostics (errors/warnings)

## Setup

1. Open this folder in VS Code:
   - `vscode-doc-guardian`
2. Install dependencies:
   - `npm install`
3. Build extension:
   - `npm run compile`
4. Press `F5` in VS Code to launch Extension Development Host.

## Configuration

In VS Code settings, you can override:

- `docGuardian.firecrawlApiKey`: Firecrawl API key
- `docGuardian.elevenLabsApiKey`: Optional ElevenLabs key override
- `docGuardian.elevenLabsVoiceId`: ElevenLabs voice id for speech output
- `docGuardian.elevenLabsAgentId`: ElevenLabs ConvAI agent id
- `docGuardian.autoSpeakResponses`: Enable/disable assistant auto speech
- `docGuardian.enableLiveMonitoring`: Enable/disable monitor
- `docGuardian.monitorDebounceMs`: Monitor debounce timing
- `docGuardian.showPopupsForAlerts`: Popup alerts for high findings
- `docGuardian.enableBackgroundDocWatch`: Enable background docs monitoring on active file
- `docGuardian.backgroundDocWatchDebounceMs`: Delay before each background docs check
- `docGuardian.backgroundDocWatchMinIntervalMs`: Minimum time between repeated alerts for same issue
- `docGuardian.enableWorkspaceBackgroundDocWatch`: Enable changed-files workspace background monitoring
- `docGuardian.workspaceBackgroundDocWatchDebounceMs`: Delay before workspace changed-file checks
- `docGuardian.workspaceBackgroundDocWatchMinIntervalMs`: Minimum time between repeated workspace alerts for same issue

## Notes

- Firecrawl and ElevenLabs are pre-wired with built-in defaults for quick install-and-run.
- Ask flow uses ElevenLabs ConvAI directly (not local mock responses).
- Firecrawl search endpoint used: `https://api.firecrawl.dev/v2/search`.
- ConvAI session endpoint used via SDK (`@elevenlabs/client`) with websocket text-only mode.
- ElevenLabs TTS endpoint used: `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`.
