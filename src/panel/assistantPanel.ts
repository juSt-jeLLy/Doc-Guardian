import * as vscode from 'vscode'
import type { DocSearchResult, MonitorFinding, WebviewIncomingMessage } from '../types'

export interface PanelHandlers {
  onAsk: (question: string) => Promise<void>
  onSearchDocs: (query: string) => Promise<void>
  onOpenUrl: (url: string) => Promise<void>
  onSetContext: () => Promise<void>
  onNewSession: () => Promise<void>
  onSwitchSession: () => Promise<void>
  onRequestPanelState: () => Promise<void>
  onSaveContext: (payload: {
    projectName: string
    stack: string
    summary: string
    docsUrls: string
  }) => Promise<void>
  onCreateSessionInline: (title?: string) => Promise<void>
  onSwitchSessionInline: (sessionId: string) => Promise<void>
}

interface PanelStateSessionItem {
  id: string
  title: string
  turnCount: number
  updatedAt: string
}

interface PanelStatePayload {
  context: {
    projectName: string
    stack: string
    summary: string
    docsUrls: string[]
  } | null
  hints: {
    projectName: string
    stack: string
    summary: string
    docsUrls: string[]
  }
  sessions: PanelStateSessionItem[]
  activeSessionId?: string
}

export class AssistantPanel implements vscode.Disposable {
  private static currentPanel: AssistantPanel | undefined

  static createOrShow(context: vscode.ExtensionContext, handlers: PanelHandlers): AssistantPanel {
    const column = vscode.window.activeTextEditor?.viewColumn

    if (AssistantPanel.currentPanel) {
      AssistantPanel.currentPanel.panel.reveal(column)
      return AssistantPanel.currentPanel
    }

    const panel = vscode.window.createWebviewPanel(
      'docGuardianAssistant',
      'Doc Guardian Assistant',
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    )

    AssistantPanel.currentPanel = new AssistantPanel(panel, context, handlers)
    return AssistantPanel.currentPanel
  }

  static getCurrent(): AssistantPanel | undefined {
    return AssistantPanel.currentPanel
  }

  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []

  private constructor(
    panel: vscode.WebviewPanel,
    _context: vscode.ExtensionContext,
    handlers: PanelHandlers
  ) {
    this.panel = panel
    this.panel.webview.html = this.getHtml(this.panel.webview)

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)

    this.panel.webview.onDidReceiveMessage(async (raw: WebviewIncomingMessage) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return

      switch (raw.type) {
        case 'ask': {
          await handlers.onAsk(raw.question)
          return
        }
        case 'searchDocs': {
          await handlers.onSearchDocs(raw.query)
          return
        }
        case 'openUrl': {
          await handlers.onOpenUrl(raw.url)
          return
        }
        case 'setContext': {
          await handlers.onSetContext()
          return
        }
        case 'newSession': {
          await handlers.onNewSession()
          return
        }
        case 'switchSession': {
          await handlers.onSwitchSession()
          return
        }
        case 'requestPanelState': {
          await handlers.onRequestPanelState()
          return
        }
        case 'saveContext': {
          await handlers.onSaveContext({
            projectName: raw.projectName,
            stack: raw.stack,
            summary: raw.summary,
            docsUrls: raw.docsUrls,
          })
          return
        }
        case 'createSessionInline': {
          await handlers.onCreateSessionInline(raw.title)
          return
        }
        case 'switchSessionInline': {
          await handlers.onSwitchSessionInline(raw.sessionId)
          return
        }
        case 'ready': {
          this.postSystemMessage('Doc Guardian connected. Ask anything about current code.')
          await handlers.onRequestPanelState()
          return
        }
        default:
          return
      }
    })
  }

  postSystemMessage(message: string): void {
    this.postMessage({ type: 'message', role: 'system', text: message })
  }

  postAssistantMessage(message: string): void {
    this.postMessage({ type: 'message', role: 'assistant', text: message })
  }

  postUserMessage(message: string): void {
    this.postMessage({ type: 'message', role: 'user', text: message })
  }

  postDocs(results: DocSearchResult[]): void {
    this.postMessage({ type: 'docs', results })
  }

  postFindings(findings: MonitorFinding[]): void {
    this.postMessage({ type: 'findings', findings })
  }

  postAudio(base64Audio: string, mimeType = 'audio/mpeg'): void {
    this.postMessage({ type: 'audio', base64Audio, mimeType })
  }

  setBusy(busy: boolean): void {
    this.postMessage({ type: 'busy', busy })
  }

  postPanelState(payload: PanelStatePayload): void {
    this.postMessage({ type: 'panelState', ...payload })
  }

  reveal(): void {
    this.panel.reveal(vscode.window.activeTextEditor?.viewColumn)
  }

  private postMessage(message: unknown): void {
    void this.panel.webview.postMessage(message)
  }

  dispose(): void {
    AssistantPanel.currentPanel = undefined
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop()
      disposable?.dispose()
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now())
    const csp = webview.cspSource

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${csp} data:; media-src ${csp} data: blob:;" />
  <title>Doc Guardian Assistant</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #080f1d;
      --bg2: #0c1528;
      --panel: #0f1d35;
      --panel-soft: #122647;
      --border: #223b6a;
      --text: #eaf2ff;
      --muted: #9db0cf;
      --accent: #4eb3ff;
      --accent-2: #73f0d4;
      --warn: #ffc857;
      --danger: #ff7f7f;
      --good: #52d8a1;
      --shadow: 0 14px 40px rgba(2, 8, 20, 0.4);
      --radius-lg: 14px;
      --radius-md: 10px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(900px 500px at 88% -10%, rgba(78, 179, 255, 0.18), transparent 55%),
        radial-gradient(800px 460px at -8% 30%, rgba(115, 240, 212, 0.12), transparent 58%),
        linear-gradient(180deg, var(--bg2), var(--bg));
      color: var(--text);
      font-family: "Avenir Next", "Segoe UI Variable", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 10px;
      padding: 10px;
    }
    header {
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 12px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: linear-gradient(145deg, rgba(15, 29, 53, 0.92), rgba(10, 20, 38, 0.92));
      box-shadow: var(--shadow);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .glyph {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      border: 1px solid rgba(78, 179, 255, 0.7);
      display: grid;
      place-items: center;
      color: var(--accent-2);
      font-size: 14px;
      background: rgba(78, 179, 255, 0.08);
    }
    .eyebrow {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--muted);
    }
    .headline {
      margin-top: 4px;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: var(--text);
    }
    .status {
      font-size: 12px;
      font-weight: 600;
      color: var(--accent-2);
      border: 1px solid rgba(82, 216, 161, 0.38);
      border-radius: 999px;
      padding: 5px 10px;
      background: rgba(82, 216, 161, 0.08);
    }
    .status.busy {
      color: var(--warn);
      border-color: rgba(255, 200, 87, 0.45);
      background: rgba(255, 200, 87, 0.08);
      animation: breathe 1.2s ease-in-out infinite;
    }
    @keyframes breathe {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255, 200, 87, 0); }
      50% { box-shadow: 0 0 0 6px rgba(255, 200, 87, 0.08); }
    }
    .layout {
      min-height: 0;
      display: grid;
      grid-template-columns: 1.35fr 1fr;
      gap: 10px;
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: linear-gradient(150deg, rgba(15, 29, 53, 0.9), rgba(10, 20, 38, 0.94));
      box-shadow: var(--shadow);
      min-height: 0;
    }
    .conversation {
      display: grid;
      grid-template-rows: auto 1fr;
      overflow: hidden;
    }
    .panel-head {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(34, 59, 106, 0.8);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .panel-meta {
      color: var(--accent);
      letter-spacing: 0.04em;
      text-transform: none;
      font-size: 11px;
    }
    #feed {
      padding: 10px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .msg {
      border: 1px solid rgba(42, 70, 122, 0.75);
      background: rgba(18, 38, 71, 0.64);
      border-radius: var(--radius-md);
      padding: 9px 10px;
      line-height: 1.4;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.assistant {
      border-color: rgba(78, 179, 255, 0.45);
      background: rgba(14, 34, 64, 0.85);
    }
    .msg.user {
      border-color: rgba(115, 240, 212, 0.42);
      background: rgba(18, 52, 66, 0.55);
    }
    .msg.system {
      border-color: rgba(255, 200, 87, 0.42);
      color: var(--muted);
      background: rgba(35, 31, 18, 0.3);
      font-size: 11.5px;
    }
    .msg.system.error {
      border-color: rgba(255, 127, 127, 0.6);
      color: #ffd2d2;
      background: rgba(67, 24, 24, 0.34);
    }
    .intel {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
    }
    .section {
      display: grid;
      grid-template-rows: auto 1fr;
      min-height: 0;
      overflow: hidden;
      flex: 1;
    }
    .section.hidden {
      display: none;
    }
    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
    }
    .section-body {
      padding: 10px;
      overflow: auto;
      min-height: 0;
    }
    .item {
      border: 1px solid rgba(46, 77, 132, 0.74);
      border-radius: var(--radius-md);
      padding: 9px;
      margin-bottom: 6px;
      font-size: 12px;
      background: rgba(16, 34, 63, 0.72);
    }
    .item-title {
      margin-bottom: 6px;
      color: var(--text);
      font-weight: 600;
      line-height: 1.35;
    }
    .item-subtle {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 6px;
    }
    .item a, .open-link {
      color: var(--accent-2);
      text-decoration: none;
      font-size: 11px;
    }
    .open-link:hover { text-decoration: underline; }
    .sev-high { border-color: rgba(255, 127, 127, 0.7); }
    .sev-medium { border-color: rgba(255, 200, 87, 0.7); }
    .sev-low { border-color: rgba(82, 216, 161, 0.7); }
    .empty {
      color: var(--muted);
      font-size: 11px;
    }
    form {
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      display: grid;
      gap: 8px;
      padding: 10px;
      background: linear-gradient(145deg, rgba(15, 29, 53, 0.95), rgba(10, 20, 38, 0.96));
      box-shadow: var(--shadow);
    }
    textarea {
      width: 100%;
      resize: vertical;
      min-height: 70px;
      max-height: 180px;
      border-radius: var(--radius-md);
      border: 1px solid rgba(54, 89, 150, 0.9);
      background: rgba(7, 18, 35, 0.92);
      color: var(--text);
      padding: 9px;
      font-size: 12px;
      font-family: inherit;
      outline: none;
      transition: border-color 120ms ease;
    }
    textarea:focus {
      border-color: rgba(115, 240, 212, 0.72);
    }
    .actions {
      display: flex;
      gap: 7px;
      justify-content: space-between;
      flex-wrap: wrap;
    }
    .action-cluster {
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
      align-items: center;
    }
    button {
      border: 1px solid rgba(55, 92, 156, 0.85);
      border-radius: 9px;
      padding: 7px 11px;
      background: rgba(22, 44, 80, 0.85);
      color: var(--text);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: transform 90ms ease, background-color 120ms ease, border-color 120ms ease;
    }
    button:hover {
      border-color: rgba(115, 240, 212, 0.6);
      background: rgba(26, 56, 102, 0.95);
    }
    button:active { transform: translateY(1px); }
    button.ghost {
      border-color: rgba(50, 81, 139, 0.78);
      background: rgba(18, 38, 71, 0.76);
    }
    button.docs {
      border-color: rgba(255, 200, 87, 0.64);
      color: #ffe7b0;
      background: rgba(80, 58, 21, 0.45);
    }
    button.primary {
      background: linear-gradient(145deg, #2f88ff, #226bd5);
      border-color: #2f88ff;
      color: white;
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .inline-editor {
      margin-top: 8px;
      border: 1px solid rgba(55, 92, 156, 0.72);
      background: rgba(10, 23, 44, 0.88);
      border-radius: var(--radius-md);
      padding: 9px;
      display: grid;
      gap: 7px;
    }
    .inline-editor.hidden { display: none; }
    .editor-title {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .field {
      display: grid;
      gap: 4px;
    }
    .field label {
      font-size: 11px;
      color: var(--muted);
    }
    .field input, .field textarea {
      border: 1px solid rgba(54, 89, 150, 0.8);
      background: rgba(7, 18, 35, 0.9);
      color: var(--text);
      border-radius: 8px;
      padding: 8px;
      font-size: 12px;
      font-family: inherit;
      width: 100%;
    }
    .field textarea {
      min-height: 62px;
      resize: vertical;
    }
    .session-list {
      display: grid;
      gap: 6px;
      max-height: 180px;
      overflow: auto;
    }
    .session-row {
      border: 1px solid rgba(42, 70, 122, 0.78);
      border-radius: 8px;
      padding: 7px 8px;
      display: grid;
      gap: 2px;
      background: rgba(18, 38, 71, 0.65);
      cursor: pointer;
    }
    .session-row.active {
      border-color: rgba(115, 240, 212, 0.74);
      background: rgba(24, 59, 78, 0.62);
    }
    .session-row-title {
      font-size: 12px;
      font-weight: 600;
    }
    .session-row-meta {
      font-size: 11px;
      color: var(--muted);
    }
    @media (max-width: 960px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .intel {
        grid-template-rows: minmax(140px, 1fr) minmax(140px, 1fr);
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="glyph">◈</div>
      <div>
        <div class="eyebrow">Doc Guardian</div>
        <div class="headline">Real-time Code + Docs Copilot</div>
      </div>
    </div>
    <div id="status" class="status">Ready</div>
  </header>

  <main class="layout">
    <section class="panel conversation">
      <div class="panel-head">
        <span>Conversation</span>
        <span class="panel-meta" id="sessionMeta">Loading workspace context…</span>
      </div>
      <div id="feed"></div>
    </section>

    <aside class="intel">
      <section class="panel section hidden" id="docsSection">
        <div class="panel-head">
          <span class="section-title">Latest Docs</span>
          <span class="panel-meta">Firecrawl</span>
        </div>
        <div class="section-body">
          <div id="docsList" class="empty">No docs yet.</div>
        </div>
      </section>
      <section class="panel section">
        <div class="panel-head">
          <span class="section-title">Live Monitor</span>
          <span class="panel-meta">Risk signals</span>
        </div>
        <div class="section-body">
          <div id="findingsList" class="empty">No active findings.</div>
        </div>
      </section>
    </aside>
  </main>

  <form id="askForm">
    <textarea id="question" placeholder="Ask while coding: explain this error, suggest fix, compare APIs..."></textarea>
    <div class="actions">
      <div class="action-cluster">
        <button type="button" class="ghost" id="dictateBtn">Dictate</button>
        <button type="button" class="ghost" id="voiceToggleBtn">Mute Voice</button>
        <button type="button" class="ghost" id="setContextBtn">Set Context</button>
        <button type="button" class="ghost" id="switchSessionBtn">Switch Session</button>
        <button type="button" class="ghost" id="newSessionBtn">New Session</button>
      </div>
      <div class="action-cluster">
        <button type="button" class="docs" id="searchBtn">Search Docs</button>
        <button type="submit" class="primary" id="askBtn">Ask Assistant</button>
      </div>
    </div>

    <section class="inline-editor hidden" id="contextEditor">
      <div class="editor-title">Workspace Context</div>
      <div class="field">
        <label for="ctxProjectName">Project name</label>
        <input id="ctxProjectName" type="text" placeholder="e.g. doc-guardian" />
      </div>
      <div class="field">
        <label for="ctxStack">Stack</label>
        <input id="ctxStack" type="text" placeholder="e.g. React, TypeScript, Node" />
      </div>
      <div class="field">
        <label for="ctxSummary">Summary</label>
        <textarea id="ctxSummary" placeholder="What are you building and what should assistant optimize for?"></textarea>
      </div>
      <div class="field">
        <label for="ctxDocs">Docs URLs (comma/newline separated)</label>
        <textarea id="ctxDocs" placeholder="https://react.dev, https://www.typescriptlang.org/docs/"></textarea>
      </div>
      <div class="action-cluster">
        <button type="button" id="saveContextBtn" class="primary">Save Context</button>
        <button type="button" id="cancelContextBtn" class="ghost">Close</button>
      </div>
    </section>

    <section class="inline-editor hidden" id="sessionEditor">
      <div class="editor-title">Sessions</div>
      <div class="field">
        <label for="newSessionTitle">New session title (optional)</label>
        <input id="newSessionTitle" type="text" placeholder="e.g. auth refactor + tests" />
      </div>
      <div class="action-cluster">
        <button type="button" id="createSessionBtn" class="primary">Create Session</button>
        <button type="button" id="closeSessionBtn" class="ghost">Close</button>
      </div>
      <div id="sessionList" class="session-list">
        <div class="empty">No sessions yet.</div>
      </div>
    </section>
  </form>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const feed = document.getElementById('feed');
    const docsList = document.getElementById('docsList');
    const docsSection = document.getElementById('docsSection');
    const findingsList = document.getElementById('findingsList');
    const status = document.getElementById('status');
    const sessionMeta = document.getElementById('sessionMeta');
    const askForm = document.getElementById('askForm');
    const questionEl = document.getElementById('question');
    const searchBtn = document.getElementById('searchBtn');
    const askBtn = document.getElementById('askBtn');
    const dictateBtn = document.getElementById('dictateBtn');
    const voiceToggleBtn = document.getElementById('voiceToggleBtn');
    const setContextBtn = document.getElementById('setContextBtn');
    const switchSessionBtn = document.getElementById('switchSessionBtn');
    const newSessionBtn = document.getElementById('newSessionBtn');
    const contextEditor = document.getElementById('contextEditor');
    const sessionEditor = document.getElementById('sessionEditor');
    const ctxProjectName = document.getElementById('ctxProjectName');
    const ctxStack = document.getElementById('ctxStack');
    const ctxSummary = document.getElementById('ctxSummary');
    const ctxDocs = document.getElementById('ctxDocs');
    const saveContextBtn = document.getElementById('saveContextBtn');
    const cancelContextBtn = document.getElementById('cancelContextBtn');
    const sessionList = document.getElementById('sessionList');
    const newSessionTitle = document.getElementById('newSessionTitle');
    const createSessionBtn = document.getElementById('createSessionBtn');
    const closeSessionBtn = document.getElementById('closeSessionBtn');
    let voiceEnabled = true;
    let lastAssistantText = '';
    let recognition = null;
    let recognizing = false;
    let lastMessageKey = '';
    const messageWindow = [];
    const MESSAGE_WINDOW_LIMIT = 40;
    const FEED_LIMIT = 140;
    let panelState = null;
    let userMessageCount = 0;
    let hasUserGestureForAudio = false;
    let hasShownAudioGestureHint = false;
    let activeAudio = null;
    let isAudioPlaying = false;
    const audioQueue = [];

    function addMessage(role, text) {
      const normalized = (text || '').trim();
      if (!normalized) return;
      const key = role + '::' + normalized;
      if (key === lastMessageKey || messageWindow.includes(key)) return;
      lastMessageKey = key;
      messageWindow.push(key);
      if (messageWindow.length > MESSAGE_WINDOW_LIMIT) messageWindow.shift();

      const div = document.createElement('div');
      div.className = 'msg ' + role;
      if (role === 'system' && /fail|error|cannot|timed out/i.test(normalized)) {
        div.className += ' error';
      }
      if (role === 'user') {
        userMessageCount += 1;
      }
      div.textContent = normalized;
      feed.appendChild(div);
      while (feed.children.length > FEED_LIMIT) {
        feed.removeChild(feed.firstChild);
      }
      feed.scrollTop = feed.scrollHeight;
    }

    function toggleContextEditor(next) {
      const shouldShow = typeof next === 'boolean' ? next : contextEditor.classList.contains('hidden');
      contextEditor.classList.toggle('hidden', !shouldShow);
      if (shouldShow) {
        sessionEditor.classList.add('hidden');
      }
    }

    function toggleSessionEditor(next) {
      const shouldShow = typeof next === 'boolean' ? next : sessionEditor.classList.contains('hidden');
      sessionEditor.classList.toggle('hidden', !shouldShow);
      if (shouldShow) {
        contextEditor.classList.add('hidden');
      }
    }

    function requestPanelState() {
      vscode.postMessage({ type: 'requestPanelState' });
    }

    function applyPanelState(state) {
      panelState = state || null;
      const context = state?.context || null;
      const hints = state?.hints || {};
      const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
      const activeSessionId = state?.activeSessionId;

      ctxProjectName.value = context?.projectName || hints.projectName || '';
      ctxStack.value = context?.stack || hints.stack || '';
      ctxSummary.value = context?.summary || hints.summary || '';
      ctxDocs.value = (context?.docsUrls || hints.docsUrls || []).join(', ');

      const active = sessions.find((s) => s.id === activeSessionId);
      if (sessionMeta) {
        if (active) {
          sessionMeta.textContent = active.title + ' • ' + active.turnCount + ' turns';
        } else {
          sessionMeta.textContent = 'No active session';
        }
      }

      renderSessionList(sessions, activeSessionId);
    }

    function relativeTime(iso) {
      if (!iso) return 'just now';
      const date = new Date(iso);
      const deltaMs = Date.now() - date.getTime();
      const min = Math.floor(deltaMs / 60000);
      if (min < 1) return 'just now';
      if (min < 60) return min + 'm ago';
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + 'h ago';
      const d = Math.floor(hr / 24);
      return d + 'd ago';
    }

    function renderSessionList(sessions, activeSessionId) {
      sessionList.innerHTML = '';
      if (!sessions || sessions.length === 0) {
        sessionList.className = 'session-list empty';
        sessionList.textContent = 'No sessions yet.';
        return;
      }

      sessionList.className = 'session-list';
      for (const session of sessions) {
        const row = document.createElement('div');
        row.className = 'session-row' + (session.id === activeSessionId ? ' active' : '');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;

        const title = document.createElement('div');
        title.className = 'session-row-title';
        title.textContent = session.title || 'Untitled session';

        const meta = document.createElement('div');
        meta.className = 'session-row-meta';
        meta.textContent = session.turnCount + ' turns • updated ' + relativeTime(session.updatedAt);

        row.appendChild(title);
        row.appendChild(meta);

        const switchTo = () => {
          vscode.postMessage({ type: 'switchSessionInline', sessionId: session.id });
        };
        row.addEventListener('click', switchTo);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            switchTo();
          }
        });

        sessionList.appendChild(row);
      }
    }

    function markAudioGesture() {
      if (hasUserGestureForAudio) return;
      hasUserGestureForAudio = true;
      hasShownAudioGestureHint = false;
      drainAudioQueue();
    }

    function stopActiveAudio() {
      if (!activeAudio) return;
      try {
        activeAudio.pause();
        activeAudio.currentTime = 0;
      } catch {}
      activeAudio = null;
      isAudioPlaying = false;
    }

    function enqueueAudio(base64Audio, mimeType) {
      if (!base64Audio) return;
      audioQueue.push({
        base64Audio,
        mimeType: mimeType || 'audio/mpeg',
      });
      drainAudioQueue();
    }

    function drainAudioQueue() {
      if (!voiceEnabled || isAudioPlaying || audioQueue.length === 0) return;

      if (!hasUserGestureForAudio) {
        if (!hasShownAudioGestureHint) {
          hasShownAudioGestureHint = true;
          addMessage('system', 'Voice is ready. Click once inside this panel to enable audio playback.');
        }
        return;
      }

      const next = audioQueue.shift();
      if (!next) return;

      const audio = new Audio('data:' + next.mimeType + ';base64,' + next.base64Audio);
      activeAudio = audio;
      isAudioPlaying = true;

      const finish = () => {
        if (activeAudio === audio) {
          activeAudio = null;
        }
        isAudioPlaying = false;
        drainAudioQueue();
      };

      audio.addEventListener('ended', finish, { once: true });
      audio.addEventListener('error', () => {
        addMessage('system', 'ElevenLabs audio playback failed in webview: audio decode/playback error.');
        finish();
      }, { once: true });

      void audio.play().catch((error) => {
        const message = error && error.message ? error.message : 'Unknown playback error';
        if (/user gesture/i.test(message) || /notallowed/i.test(message)) {
          hasUserGestureForAudio = false;
          audioQueue.unshift(next);
          if (!hasShownAudioGestureHint) {
            hasShownAudioGestureHint = true;
            addMessage('system', 'Click once inside this panel to enable voice playback.');
          }
        } else {
          addMessage('system', 'ElevenLabs audio playback failed in webview: ' + message);
        }
        finish();
      });
    }

    function initSpeechRecognition() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) return;
      recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.continuous = false;
      recognition.onstart = () => {
        recognizing = true;
        dictateBtn.textContent = 'Listening...';
      };
      recognition.onend = () => {
        recognizing = false;
        dictateBtn.textContent = 'Dictate';
      };
      recognition.onerror = () => {
        recognizing = false;
        dictateBtn.textContent = 'Dictate';
      };
      recognition.onresult = (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript?.trim() || '';
        if (!transcript) return;
        questionEl.value = transcript;
        vscode.postMessage({ type: 'ask', question: transcript });
      };
    }

    function renderDocs(results) {
      docsList.innerHTML = '';
      if (!results || results.length === 0) {
        docsList.className = 'empty';
        docsList.textContent = 'No docs found for this query.';
        docsSection.classList.add('hidden');
        return;
      }
      docsSection.classList.remove('hidden');
      docsList.className = '';
      for (const doc of results) {
        const item = document.createElement('div');
        item.className = 'item';
        const title = document.createElement('div');
        const source = document.createElement('div');
        const open = document.createElement('a');
        const snippet = document.createElement('div');

        title.className = 'item-title';
        title.textContent = doc.title;
        source.className = 'item-subtle';
        source.textContent = doc.source || 'web';

        open.textContent = 'Open source ↗';
        open.className = 'open-link';
        open.href = '#';
        open.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'openUrl', url: doc.url });
        });
        snippet.textContent = doc.snippet || '';
        snippet.className = 'item-subtle';

        item.appendChild(title);
        item.appendChild(source);
        item.appendChild(open);
        item.appendChild(snippet);
        docsList.appendChild(item);
      }
    }

    function renderFindings(findings) {
      findingsList.innerHTML = '';
      if (!findings || findings.length === 0) {
        findingsList.className = 'empty';
        findingsList.textContent = 'No active findings.';
        return;
      }
      findingsList.className = '';
      for (const finding of findings.slice(0, 8)) {
        const item = document.createElement('div');
        item.className = 'item sev-' + finding.severity;
        const title = document.createElement('div');
        title.className = 'item-title';
        title.textContent = '[' + finding.severity.toUpperCase() + '] ' + finding.message;
        const detail = document.createElement('div');
        detail.className = 'item-subtle';
        const where = (finding.filePath || '').split('/').pop() || 'unknown file';
        detail.textContent = where + ' • line ' + (finding.line || '?') + (finding.rule ? (' • ' + finding.rule) : '');
        item.appendChild(title);
        item.appendChild(detail);
        findingsList.appendChild(item);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'message') {
        addMessage(msg.role, msg.text);
        if (msg.role === 'assistant') {
          lastAssistantText = msg.text || '';
        }
      } else if (msg.type === 'docs') {
        renderDocs(msg.results);
      } else if (msg.type === 'findings') {
        renderFindings(msg.findings);
      } else if (msg.type === 'panelState') {
        applyPanelState(msg);
      } else if (msg.type === 'audio') {
        // Skip the startup assistant intro before the first real user turn.
        if (userMessageCount === 0) return;
        if (!voiceEnabled || !msg.base64Audio) return;
        enqueueAudio(msg.base64Audio, msg.mimeType);
      } else if (msg.type === 'busy') {
        status.textContent = msg.busy ? 'Thinking…' : 'Ready';
        status.classList.toggle('busy', !!msg.busy);
        askBtn.disabled = !!msg.busy;
        searchBtn.disabled = !!msg.busy;
        dictateBtn.disabled = !!msg.busy;
      }
    });

    askForm.addEventListener('submit', (event) => {
      markAudioGesture();
      event.preventDefault();
      const question = questionEl.value.trim();
      if (!question) return;
      vscode.postMessage({ type: 'ask', question });
      questionEl.value = '';
    });

    questionEl.addEventListener('keydown', (event) => {
      markAudioGesture();
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const question = questionEl.value.trim();
        if (!question) return;
        vscode.postMessage({ type: 'ask', question });
        questionEl.value = '';
      }
    });

    searchBtn.addEventListener('click', () => {
      markAudioGesture();
      const query = questionEl.value.trim();
      if (!query) return;
      vscode.postMessage({ type: 'searchDocs', query });
    });

    dictateBtn.addEventListener('click', () => {
      markAudioGesture();
      if (!recognition) {
        addMessage('system', 'Speech recognition is not available in this VS Code runtime.');
        return;
      }
      if (recognizing) {
        recognition.stop();
        return;
      }
      recognition.start();
    });

    voiceToggleBtn.addEventListener('click', () => {
      markAudioGesture();
      voiceEnabled = !voiceEnabled;
      voiceToggleBtn.textContent = voiceEnabled ? 'Mute Voice' : 'Unmute Voice';
      if (!voiceEnabled) {
        stopActiveAudio();
        audioQueue.length = 0;
      } else {
        drainAudioQueue();
      }
    });

    window.addEventListener('pointerdown', markAudioGesture, { once: true });
    window.addEventListener('keydown', markAudioGesture, { once: true });

    setContextBtn.addEventListener('click', () => {
      toggleContextEditor();
      if (!contextEditor.classList.contains('hidden')) {
        requestPanelState();
      }
    });

    switchSessionBtn.addEventListener('click', () => {
      toggleSessionEditor();
      if (!sessionEditor.classList.contains('hidden')) {
        requestPanelState();
      }
    });

    newSessionBtn.addEventListener('click', () => {
      toggleSessionEditor(true);
      requestPanelState();
      newSessionTitle.focus();
    });

    saveContextBtn.addEventListener('click', () => {
      const payload = {
        projectName: (ctxProjectName.value || '').trim(),
        stack: (ctxStack.value || '').trim(),
        summary: (ctxSummary.value || '').trim(),
        docsUrls: (ctxDocs.value || '').trim(),
      };
      if (!payload.projectName || !payload.stack || !payload.summary) {
        addMessage('system', 'Context save failed: project, stack, and summary are required.');
        return;
      }
      vscode.postMessage({ type: 'saveContext', ...payload });
      toggleContextEditor(false);
    });

    cancelContextBtn.addEventListener('click', () => {
      toggleContextEditor(false);
    });

    createSessionBtn.addEventListener('click', () => {
      const title = (newSessionTitle.value || '').trim();
      vscode.postMessage({ type: 'createSessionInline', title });
      newSessionTitle.value = '';
    });

    closeSessionBtn.addEventListener('click', () => {
      toggleSessionEditor(false);
    });

    initSpeechRecognition();
    vscode.postMessage({ type: 'ready' });
    requestPanelState();
  </script>
</body>
</html>`
  }
}
