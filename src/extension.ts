import * as vscode from 'vscode'
import * as path from 'path'
import { getConfig } from './config'
import { AssistantPanel } from './panel/assistantPanel'
import { CodeMonitorService } from './services/codeMonitorService'
import { ConvaiService } from './services/convaiService'
import { DocSearchService } from './services/docSearchService'
import { SessionStore } from './services/sessionStore'
import { VoiceService } from './services/voiceService'
import { DebounceMap } from './utils/debounce'
import type {
  AssistantContext,
  MonitorFinding,
  ProjectContext,
  ReferencedFileContext,
  StoredSession,
} from './types'

let monitorService: CodeMonitorService | undefined
let convaiService: ConvaiService | undefined
let sessionStore: SessionStore | undefined
let statusBarItem: vscode.StatusBarItem | undefined
let outputChannel: vscode.OutputChannel | undefined
let lastPopupAt = 0
let hasPromptedForContextThisRun = false
let latestQuestionForContext = ''
const backgroundDocDebouncer = new DebounceMap()
const lastBackgroundCheckBySignature = new Map<string, number>()
const lastBackgroundAlertBySignature = new Map<string, number>()

const MAX_REFERENCED_FILES = 10
const MAX_FILE_CONTENT_CHARS = 10_000
const MAX_TOTAL_REFERENCED_CHARS = 45_000
const MAX_IMPORTED_REFERENCED_FILES = 8
const MAX_WORKSPACE_REFERENCED_FILES = 8
const WORKSPACE_SCAN_INCLUDE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,swift,php,rb,json,yaml,yml,md}'
const WORKSPACE_SCAN_EXCLUDE_GLOB =
  '**/{node_modules,dist,.next,.git,out,build,.turbo,.cache,coverage,.venv,venv,target,.idea}/**'

type BackgroundWatchScope = 'active' | 'workspace'

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Doc Guardian')
  context.subscriptions.push(outputChannel)

  const docSearchService = new DocSearchService()
  const voiceService = new VoiceService()
  sessionStore = new SessionStore(context)

  monitorService = new CodeMonitorService({
    onFindings: (findings) => {
      onMonitorFindings(findings)
    },
  })
  monitorService.start()
  context.subscriptions.push(monitorService)

  try {
    convaiService = new ConvaiService({
      getCodeContext: async () => buildAssistantContext(latestQuestionForContext),
      searchDocs: async (query) => docSearchService.searchDocs(query),
      getMonitorFindings: () => getActiveMonitorFindings(),
      onAssistantMessage: async (message) => {
        const panel = AssistantPanel.getCurrent()
        if (!panel) return

        panel.postAssistantMessage(message)
        await maybeSpeak(panel, message, voiceService)
      },
      onSystemMessage: (message) => {
        AssistantPanel.getCurrent()?.postSystemMessage(message)
        output(message)
      },
      onDocs: (query, results) => {
        AssistantPanel.getCurrent()?.postDocs(results)
        const store = sessionStore
        if (!store) return
        const workspaceKey = store.getWorkspaceKey()
        void store.addDocLookup(workspaceKey, query, results).catch((error) => {
          output(`Session doc save failed: ${toMessage(error)}`)
        })
      },
      onFindings: (findings) => {
        AssistantPanel.getCurrent()?.postFindings(findings)
      },
      onStatusChange: (status) => {
        output(`ConvAI status: ${status}`)
        if (status === 'connected' && sessionStore) {
          const workspaceKey = sessionStore.getWorkspaceKey()
          void syncContextToConvai(sessionStore, workspaceKey)
          void publishPanelState(sessionStore, AssistantPanel.getCurrent())
        }
      },
    })
  } catch (error) {
    convaiService = undefined
    output(`ConvAI init failed: ${toMessage(error)}`)
  }
  context.subscriptions.push(
    new vscode.Disposable(() => {
      convaiService?.dispose()
      convaiService = undefined
    })
  )

  const openPanel = (): AssistantPanel => {
    const panel = AssistantPanel.createOrShow(context, {
      onAsk: async (question) => {
        await handleAskQuestion(question, convaiService, sessionStore)
      },
      onSearchDocs: async (query) => {
        await handleSearchDocs(query, docSearchService, voiceService, sessionStore)
      },
      onOpenUrl: async (url) => {
        await openExternalUrl(url)
      },
      onSetContext: async () => {
        await setProjectContextFlow(sessionStore, panel, true)
      },
      onNewSession: async () => {
        await createNewSessionFlow(sessionStore, panel)
      },
      onSwitchSession: async () => {
        await switchSessionFlow(sessionStore, panel)
      },
      onRequestPanelState: async () => {
        await publishPanelState(sessionStore, panel)
      },
      onSaveContext: async (payload) => {
        await saveProjectContextInline(sessionStore, panel, payload)
      },
      onCreateSessionInline: async (title) => {
        await createSessionInlineFlow(sessionStore, panel, title)
      },
      onSwitchSessionInline: async (sessionId) => {
        await switchSessionInlineFlow(sessionStore, panel, sessionId)
      },
    })
    panel.reveal()
    void bootPanel(panel)
    return panel
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('docGuardian.openAssistant', () => {
      openPanel()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('docGuardian.searchDocs', async () => {
      const selectedText = getSelectedText() || ''
      const query = await vscode.window.showInputBox({
        prompt: 'Search docs for current coding task',
        value: selectedText,
        placeHolder: 'e.g. react usememo dependencies',
      })

      if (!query?.trim()) return
      openPanel()
      await handleSearchDocs(query, docSearchService, voiceService, sessionStore)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('docGuardian.askAboutSelection', async () => {
      const selected = getSelectedText()
      if (!selected) {
        vscode.window.showInformationMessage(
          'Select some code first, then run Ask About Selection.'
        )
        return
      }

      const question = await vscode.window.showInputBox({
        prompt: 'What do you want to know about this selection?',
        value: 'Explain this code and suggest improvements.',
      })
      if (!question?.trim()) return

      openPanel()
      await handleAskQuestion(
        `${question}\n\nSelected code:\n${selected}`,
        convaiService,
        sessionStore
      )
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('docGuardian.setProjectContext', async () => {
      const panel = openPanel()
      await setProjectContextFlow(sessionStore, panel, true)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('docGuardian.newSession', async () => {
      const panel = openPanel()
      await createNewSessionFlow(sessionStore, panel)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('docGuardian.switchSession', async () => {
      const panel = openPanel()
      await switchSessionFlow(sessionStore, panel)
    })
  )

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  statusBarItem.command = 'docGuardian.openAssistant'
  statusBarItem.text = '$(search-view-icon) Doc Guardian'
  statusBarItem.tooltip = 'Open Doc Guardian Assistant'
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  setupBackgroundDocWatch(context, docSearchService)

  output('Activated successfully.')
}

export function deactivate(): void {
  convaiService?.dispose()
  convaiService = undefined
  sessionStore = undefined
  backgroundDocDebouncer.clearAll()
  lastBackgroundCheckBySignature.clear()
  lastBackgroundAlertBySignature.clear()
  monitorService?.dispose()
  monitorService = undefined
  statusBarItem?.dispose()
  statusBarItem = undefined
  outputChannel?.dispose()
  outputChannel = undefined
}

async function bootPanel(panel: AssistantPanel): Promise<void> {
  const store = sessionStore
  const convai = convaiService

  if (convai) {
    try {
      await convai.ensureSession()
    } catch (error) {
      const message = toMessage(error)
      panel.postSystemMessage(`ConvAI connection failed: ${message}`)
      output(`ConvAI connection failed: ${message}`)
    }
  }

  if (!store) return

  const workspaceKey = store.getWorkspaceKey()
  await store.getOrCreateActiveSession(workspaceKey)
  const projectContext = store.getProjectContext(workspaceKey)

  if (!hasPromptedForContextThisRun && !projectContext) {
    hasPromptedForContextThisRun = true
    const selection = await vscode.window.showInformationMessage(
      'Set project context for this repo so Doc Guardian keeps answers grounded in your stack and goals.',
      'Set Context',
      'Later'
    )
    if (selection === 'Set Context') {
      await setProjectContextFlow(store, panel, true)
    } else {
      panel.postSystemMessage(
        'Project context is empty. Use "Set Context" to save stack + repo goals for this workspace.'
      )
    }
  } else {
    await syncContextToConvai(store, workspaceKey)
  }

  await publishPanelState(store, panel)
}

async function handleAskQuestion(
  question: string,
  convai: ConvaiService | undefined,
  store: SessionStore | undefined
): Promise<void> {
  const panel = AssistantPanel.getCurrent()
  if (!panel) return
  if (!convai) {
    panel.postSystemMessage('ConvAI is not initialized.')
    return
  }

  panel.setBusy(true)
  panel.postUserMessage(question)
  latestQuestionForContext = question

  const workspaceKey = store?.getWorkspaceKey()

  try {
    if (store && workspaceKey) {
      await store.getOrCreateActiveSession(workspaceKey)
      await store.appendTurn(workspaceKey, 'user', question)
      await syncContextToConvai(store, workspaceKey)
    }

    let answer: string
    try {
      answer = await convai.ask(question)
    } catch (error) {
      if (!isRecoverableConvaiDisconnect(error)) {
        throw error
      }

      panel.postSystemMessage('ConvAI connection dropped. Reconnecting and retrying…')
      output(`ConvAI dropped; retrying once: ${toMessage(error)}`)
      await convai.ensureSession()
      if (store && workspaceKey) {
        await syncContextToConvai(store, workspaceKey)
      }
      answer = await convai.ask(question)
    }

    if (store && workspaceKey) {
      await store.appendTurn(workspaceKey, 'assistant', answer)
    }
  } catch (error) {
    const message = toMessage(error)
    panel.postSystemMessage(`Assistant failed: ${message}`)
    output(`Ask failed: ${message}`)
  } finally {
    if (store && workspaceKey) {
      await publishPanelState(store, panel)
    }
    panel.setBusy(false)
  }
}

async function handleSearchDocs(
  query: string,
  docSearchService: DocSearchService,
  voiceService: VoiceService,
  store: SessionStore | undefined
): Promise<void> {
  const panel = AssistantPanel.getCurrent()
  if (!panel) return

  panel.setBusy(true)
  panel.postUserMessage(`Search docs: ${query}`)

  try {
    const docs = await docSearchService.searchDocs(query)
    panel.postDocs(docs)

    const workspaceKey = store?.getWorkspaceKey()
    if (store && workspaceKey) {
      await store.addDocLookup(workspaceKey, query, docs)
    }

    if (docs.length === 0) {
      panel.postSystemMessage('No docs found for this query.')
      return
    }

    const summary = docs
      .slice(0, 3)
      .map((doc, index) => `${index + 1}. ${doc.title}\n${doc.url}`)
      .join('\n\n')

    const responseText = `Top docs for "${query}":\n\n${summary}`
    panel.postAssistantMessage(responseText)
    await maybeSpeak(panel, responseText, voiceService)
  } catch (error) {
    const message = toMessage(error)
    panel.postSystemMessage(`Docs search failed: ${message}`)
    output(`Search failed: ${message}`)
  } finally {
    if (store) {
      await publishPanelState(store, panel)
    }
    panel.setBusy(false)
  }
}

async function setProjectContextFlow(
  store: SessionStore | undefined,
  panel: AssistantPanel | undefined,
  announce: boolean
): Promise<void> {
  if (!store) return

  const workspaceKey = store.getWorkspaceKey()
  const current = store.getProjectContext(workspaceKey)
  const hints = await deriveProjectContextHints(workspaceKey, current)

  const projectName = await vscode.window.showInputBox({
    prompt: 'Project name',
    value: current?.projectName ?? hints.projectName,
    placeHolder: 'e.g. Acme Frontend',
    validateInput: (value) => (value.trim().length > 0 ? null : 'Project name is required'),
  })
  if (projectName === undefined) return

  const stack = await vscode.window.showInputBox({
    prompt: 'Tech stack',
    value: current?.stack ?? hints.stack,
    placeHolder: 'e.g. React, TypeScript, Node, Postgres',
    validateInput: (value) => (value.trim().length > 0 ? null : 'Tech stack is required'),
  })
  if (stack === undefined) return

  const summary = await vscode.window.showInputBox({
    prompt: 'What are you building and what should the assistant optimize for?',
    value: current?.summary ?? hints.summary,
    placeHolder: 'e.g. VS Code extension for enterprise React teams. Prioritize fast fixes and safe patches.',
    validateInput: (value) => (value.trim().length > 0 ? null : 'Project summary is required'),
  })
  if (summary === undefined) return

  const docsUrlsRaw = await vscode.window.showInputBox({
    prompt: 'Reference docs URLs (comma or newline separated)',
    value: (current?.docsUrls ?? hints.docsUrls).join(', '),
    placeHolder: 'https://react.dev, https://www.typescriptlang.org/docs/',
    validateInput: (value) => validateDocsUrlsInput(value),
  })
  if (docsUrlsRaw === undefined) return

  const saved = await store.setProjectContext(workspaceKey, {
    projectName: projectName.trim(),
    stack: stack.trim(),
    summary: summary.trim(),
    docsUrls: parseDocsUrls(docsUrlsRaw),
  })

  if (announce) {
    const docsCount = saved.docsUrls?.length ?? 0
    panel?.postSystemMessage(
      `Context saved: ${saved.projectName} (${saved.stack}) with ${docsCount} docs URL${docsCount === 1 ? '' : 's'}. This workspace context will be reused in future sessions.`
    )
  }

  await syncContextToConvai(store, workspaceKey)
  await publishPanelState(store, panel)
}

interface InlineContextPayload {
  projectName: string
  stack: string
  summary: string
  docsUrls: string
}

async function publishPanelState(
  store: SessionStore | undefined,
  panel: AssistantPanel | undefined
): Promise<void> {
  if (!store || !panel) return

  const workspaceKey = store.getWorkspaceKey()
  const context = store.getProjectContext(workspaceKey)
  const hints = await deriveProjectContextHints(workspaceKey, context)
  const activeSession = await store.getOrCreateActiveSession(workspaceKey)
  const sessions = store.getSessions(workspaceKey).map((session) => ({
    id: session.id,
    title: session.title,
    turnCount: session.turns.length,
    updatedAt: session.updatedAt,
  }))

  panel.postPanelState({
    context: context
      ? {
          projectName: context.projectName,
          stack: context.stack,
          summary: context.summary,
          docsUrls: context.docsUrls ?? [],
        }
      : null,
    hints: {
      projectName: hints.projectName,
      stack: hints.stack,
      summary: hints.summary,
      docsUrls: hints.docsUrls,
    },
    sessions,
    activeSessionId: activeSession.id,
  })
}

async function saveProjectContextInline(
  store: SessionStore | undefined,
  panel: AssistantPanel | undefined,
  payload: InlineContextPayload
): Promise<void> {
  if (!store) return
  const workspaceKey = store.getWorkspaceKey()
  const projectName = payload.projectName.trim()
  const stack = payload.stack.trim()
  const summary = payload.summary.trim()

  if (!projectName || !stack || !summary) {
    panel?.postSystemMessage('Context save failed: project, stack, and summary are required.')
    return
  }

  const docsValidation = validateDocsUrlsInput(payload.docsUrls ?? '')
  if (docsValidation) {
    panel?.postSystemMessage(`Context save failed: ${docsValidation}`)
    return
  }

  const saved = await store.setProjectContext(workspaceKey, {
    projectName,
    stack,
    summary,
    docsUrls: parseDocsUrls(payload.docsUrls ?? ''),
  })

  panel?.postSystemMessage(
    `Context saved for ${saved.projectName}.`
  )
  await syncContextToConvai(store, workspaceKey)
  await publishPanelState(store, panel)
}

async function createSessionInlineFlow(
  store: SessionStore | undefined,
  panel: AssistantPanel | undefined,
  title: string | undefined
): Promise<void> {
  if (!store) return

  const workspaceKey = store.getWorkspaceKey()
  const created = await store.createSession(workspaceKey, title?.trim())
  panel?.postSystemMessage(`Started new session: ${created.title}`)
  await syncContextToConvai(store, workspaceKey)
  await publishPanelState(store, panel)
}

async function switchSessionInlineFlow(
  store: SessionStore | undefined,
  panel: AssistantPanel | undefined,
  sessionId: string
): Promise<void> {
  if (!store || !sessionId) return

  const workspaceKey = store.getWorkspaceKey()
  const switched = await store.switchActiveSession(workspaceKey, sessionId)
  if (!switched) {
    panel?.postSystemMessage('Could not switch session. It may have been removed.')
    await publishPanelState(store, panel)
    return
  }

  panel?.postSystemMessage(`Switched session: ${switched.title}`)
  await syncContextToConvai(store, workspaceKey)
  await publishPanelState(store, panel)
}

async function createNewSessionFlow(
  store: SessionStore | undefined,
  panel: AssistantPanel | undefined
): Promise<void> {
  if (!store) return
  const workspaceKey = store.getWorkspaceKey()
  const title = await vscode.window.showInputBox({
    prompt: 'New session title (optional)',
    placeHolder: 'e.g. Refactor auth flow',
  })

  const created = await store.createSession(workspaceKey, title)
  panel?.postSystemMessage(`Started new session: ${created.title}`)
  await syncContextToConvai(store, workspaceKey)
  await publishPanelState(store, panel)
}

async function switchSessionFlow(
  store: SessionStore | undefined,
  panel: AssistantPanel | undefined
): Promise<void> {
  if (!store) return

  const workspaceKey = store.getWorkspaceKey()
  const sessions = store.getSessions(workspaceKey)

  if (sessions.length === 0) {
    await createNewSessionFlow(store, panel)
    return
  }

  const picks: Array<vscode.QuickPickItem & { sessionId?: string; createNew?: boolean }> = [
    {
      label: '$(add) Create New Session',
      description: 'Start fresh while keeping same project context',
      createNew: true,
    },
    ...sessions.map((session) => ({
      label: session.title,
      description: `${session.turns.length} turns`,
      detail: `Updated ${formatRelativeIso(session.updatedAt)}`,
      sessionId: session.id,
    })),
  ]

  const selected = await vscode.window.showQuickPick(picks, {
    title: 'Switch Doc Guardian Session',
    placeHolder: 'Select a saved session',
  })

  if (!selected) return

  if (selected.createNew) {
    await createNewSessionFlow(store, panel)
    return
  }

  if (!selected.sessionId) return
  const switched = await store.switchActiveSession(workspaceKey, selected.sessionId)
  if (!switched) return

  panel?.postSystemMessage(`Switched session: ${switched.title}`)
  await syncContextToConvai(store, workspaceKey)
  await publishPanelState(store, panel)
}

async function syncContextToConvai(
  store: SessionStore,
  workspaceKey: string
): Promise<void> {
  const convai = convaiService
  if (!convai) return

  const session = await store.getOrCreateActiveSession(workspaceKey)
  const projectContext = store.getProjectContext(workspaceKey)
  const update = buildContextUpdatePayload(session, projectContext, store, workspaceKey)

  try {
    await convai.updateContext(update)
  } catch (error) {
    output(`Context sync failed: ${toMessage(error)}`)
  }
}

function buildContextUpdatePayload(
  session: StoredSession,
  projectContext: ProjectContext | undefined,
  store: SessionStore,
  workspaceKey: string
): string {
  const docsUrls = projectContext?.docsUrls ?? []
  const contextBlock = projectContext
    ? [
        `Project: ${projectContext.projectName}`,
        `Stack: ${projectContext.stack}`,
        `Summary: ${projectContext.summary}`,
        `Reference docs URLs: ${docsUrls.length > 0 ? docsUrls.join(', ') : 'None provided'}`,
      ].join('\n')
    : 'Project context not set yet.'

  const recentTurns = store
    .getRecentTurns(workspaceKey, 6)
    .map((turn) => `${turn.role.toUpperCase()}: ${truncate(turn.text, 220)}`)
    .join('\n')

  const recentDocs = store
    .getRecentDocLookups(workspaceKey, 3)
    .map((lookup) => `${lookup.query} -> ${lookup.topUrls.join(', ')}`)
    .join('\n')

  return [
    'Workspace context for this user session:',
    contextBlock,
    `Active session: ${session.title}`,
    `Recent turns:\n${recentTurns || 'None'}`,
    `Recent docs lookups:\n${recentDocs || 'None'}`,
    'Use this context to keep responses grounded in the active repo and prior discussion.',
  ].join('\n\n')
}

function renderSessionSummary(
  session: StoredSession,
  projectContext: ProjectContext | undefined
): string {
  const contextLabel = projectContext
    ? `${projectContext.projectName} (${projectContext.stack})`
    : 'not set'
  const docsCount = projectContext?.docsUrls?.length ?? 0
  return `Session: ${session.title} • ${session.turns.length} turns • Context: ${contextLabel} • Docs: ${docsCount}`
}

function onMonitorFindings(findings: MonitorFinding[]): void {
  if (findings.length === 0) {
    return
  }

  const panel = AssistantPanel.getCurrent()
  panel?.postFindings(findings)

  const highCount = findings.filter((finding) => finding.severity === 'high').length
  if (statusBarItem) {
    const label =
      highCount > 0 ? `${findings.length} findings (${highCount} high)` : `${findings.length} findings`
    statusBarItem.text = `$(warning) Doc Guardian: ${label}`
  }

  const cfg = getConfig()
  if (!cfg.showPopupsForAlerts) return

  const now = Date.now()
  if (now - lastPopupAt < 20_000) return

  const critical = findings.find((finding) => finding.severity === 'high')
  if (!critical) return

  lastPopupAt = now
  void vscode.window
    .showWarningMessage(
      `Doc Guardian: ${critical.message} (${critical.filePath.split('/').pop()}:${critical.line})`,
      'Open Assistant'
    )
    .then((selection) => {
      if (selection === 'Open Assistant') {
        void vscode.commands.executeCommand('docGuardian.openAssistant')
      }
    })
}

function setupBackgroundDocWatch(
  context: vscode.ExtensionContext,
  docSearchService: DocSearchService
): void {
  const scheduleByUri = (
    uri: vscode.Uri | undefined,
    reason: string,
    scope: BackgroundWatchScope
  ): void => {
    if (!uri) return
    if (uri.scheme !== 'file') return

    const cfg = getConfig()
    if (scope === 'active' && !cfg.enableBackgroundDocWatch) return
    if (scope === 'workspace' && !cfg.enableWorkspaceBackgroundDocWatch) return

    const debounceMs =
      scope === 'active'
        ? cfg.backgroundDocWatchDebounceMs
        : cfg.workspaceBackgroundDocWatchDebounceMs

    const debounceKey = `background:${scope}:${uri.toString()}`
    backgroundDocDebouncer.schedule(debounceKey, debounceMs, () => {
      void runBackgroundDocCheck(uri, reason, scope, docSearchService)
    })
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      scheduleByUri(editor?.document.uri, 'active_change', 'active')
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const active = vscode.window.activeTextEditor?.document
      if (active?.uri.toString() === document.uri.toString()) {
        scheduleByUri(document.uri, 'save', 'active')
      } else {
        scheduleByUri(document.uri, 'workspace_save', 'workspace')
      }
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const active = vscode.window.activeTextEditor?.document
      if (active?.uri.toString() === event.document.uri.toString()) {
        scheduleByUri(event.document.uri, 'edit', 'active')
      } else {
        scheduleByUri(event.document.uri, 'workspace_edit', 'workspace')
      }
    })
  )

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((event) => {
      const active = vscode.window.activeTextEditor?.document
      for (const uri of event.uris) {
        if (active?.uri.toString() === uri.toString()) {
          scheduleByUri(uri, 'diagnostics', 'active')
        } else {
          scheduleByUri(uri, 'workspace_diagnostics', 'workspace')
        }
      }
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration('docGuardian.enableBackgroundDocWatch') &&
        !event.affectsConfiguration('docGuardian.backgroundDocWatchDebounceMs') &&
        !event.affectsConfiguration('docGuardian.backgroundDocWatchMinIntervalMs') &&
        !event.affectsConfiguration('docGuardian.enableWorkspaceBackgroundDocWatch') &&
        !event.affectsConfiguration('docGuardian.workspaceBackgroundDocWatchDebounceMs') &&
        !event.affectsConfiguration('docGuardian.workspaceBackgroundDocWatchMinIntervalMs')
      ) {
        return
      }
      scheduleByUri(vscode.window.activeTextEditor?.document.uri, 'config_change', 'active')
    })
  )

  scheduleByUri(vscode.window.activeTextEditor?.document.uri, 'startup', 'active')
}

async function runBackgroundDocCheck(
  uri: vscode.Uri,
  reason: string,
  scope: BackgroundWatchScope,
  docSearchService: DocSearchService
): Promise<void> {
  const cfg = getConfig()
  if (scope === 'active' && !cfg.enableBackgroundDocWatch) return
  if (scope === 'workspace' && !cfg.enableWorkspaceBackgroundDocWatch) return

  const document = await getDocumentForUri(uri)
  if (!document) return
  if (document.uri.scheme !== 'file') return

  const active = vscode.window.activeTextEditor?.document
  if (scope === 'active') {
    if (!active) return
    if (active.uri.toString() !== document.uri.toString()) return
  }
  if (scope === 'workspace') {
    if (active && active.uri.toString() === document.uri.toString()) {
      return
    }
  }

  await monitorService?.analyzeDocument(document)

  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .filter(
      (diag) =>
        diag.severity === vscode.DiagnosticSeverity.Error ||
        diag.severity === vscode.DiagnosticSeverity.Warning
    )
    .slice(0, 5)

  const findings =
    monitorService
      ?.getFindingsForDocument(document)
      .filter((finding) => finding.severity === 'high' || finding.severity === 'medium')
      .slice(0, 8) ?? []

  if (diagnostics.length === 0 && findings.length === 0) {
    return
  }

  const issueSignature = buildBackgroundIssueSignature(document.uri.fsPath, diagnostics, findings)
  const now = Date.now()
  const minIntervalMs =
    scope === 'active'
      ? cfg.backgroundDocWatchMinIntervalMs
      : cfg.workspaceBackgroundDocWatchMinIntervalMs
  const lastCheckAt = lastBackgroundCheckBySignature.get(issueSignature)
  if (typeof lastCheckAt === 'number' && now - lastCheckAt < minIntervalMs) {
    return
  }
  lastBackgroundCheckBySignature.set(issueSignature, now)

  const query = buildBackgroundDocQuery(document, diagnostics, findings)
  if (!query) return

  const docs = await docSearchService.searchDocs(query)
  if (docs.length === 0) return

  const alertSignature = `${issueSignature}|${docs[0].url}`
  const lastAlertAt = lastBackgroundAlertBySignature.get(alertSignature)
  if (typeof lastAlertAt === 'number' && now - lastAlertAt < minIntervalMs) {
    return
  }
  lastBackgroundAlertBySignature.set(alertSignature, now)

  const errorCount = diagnostics.filter(
    (diag) => diag.severity === vscode.DiagnosticSeverity.Error
  ).length
  const warningCount = diagnostics.filter(
    (diag) => diag.severity === vscode.DiagnosticSeverity.Warning
  ).length
  const highFindingCount = findings.filter((finding) => finding.severity === 'high').length

  const fileName = path.basename(document.uri.fsPath)
  const watchLabel = scope === 'active' ? 'Background watch' : 'Workspace watch'
  const summary = `${watchLabel}: ${fileName} (${reason}) has ${errorCount} error(s), ${warningCount} warning(s), ${highFindingCount} high finding(s).`
  const topDoc = docs[0]
  const detail = `Related docs: ${topDoc.title} — ${topDoc.url}`

  output(`${summary} ${detail}`)

  const panel = AssistantPanel.getCurrent()
  panel?.postSystemMessage(`${summary}\n${detail}`)
  panel?.postDocs(docs)

  if (!cfg.showPopupsForAlerts) {
    return
  }

  const hasHighSignal = errorCount > 0 || highFindingCount > 0
  if (scope === 'workspace' && !hasHighSignal) {
    return
  }

  if (scope === 'workspace') {
    const actions: Array<'Open File' | 'Open Assistant' | 'Open Top Doc'> = [
      'Open File',
      'Open Assistant',
      'Open Top Doc',
    ]
    const selection = await vscode.window.showWarningMessage(
      `${summary} ${topDoc.title}`,
      ...actions
    )

    if (selection === 'Open File') {
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
      })
    }
    if (selection === 'Open Assistant') {
      await vscode.commands.executeCommand('docGuardian.openAssistant')
    }
    if (selection === 'Open Top Doc') {
      await openExternalUrl(topDoc.url)
    }
    return
  }

  const actions: Array<'Open Assistant' | 'Open Top Doc'> = ['Open Assistant', 'Open Top Doc']
  const selection = hasHighSignal
    ? await vscode.window.showWarningMessage(`${summary} ${topDoc.title}`, ...actions)
    : await vscode.window.showInformationMessage(`${summary} ${topDoc.title}`, ...actions)

  if (selection === 'Open Assistant') {
    await vscode.commands.executeCommand('docGuardian.openAssistant')
  }
  if (selection === 'Open Top Doc') {
    await openExternalUrl(topDoc.url)
  }
}

async function getDocumentForUri(
  uri: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  const existing = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === uri.toString()
  )
  if (existing) {
    return existing
  }

  try {
    return await vscode.workspace.openTextDocument(uri)
  } catch {
    return undefined
  }
}

function buildBackgroundIssueSignature(
  filePath: string,
  diagnostics: vscode.Diagnostic[],
  findings: MonitorFinding[]
): string {
  const diagPart = diagnostics
    .slice(0, 4)
    .map((diag) => `${diag.severity}:${diag.range.start.line}:${diag.message}`)
    .join('|')

  const findingPart = findings
    .slice(0, 6)
    .map((finding) => `${finding.severity}:${finding.rule}:${finding.line}:${finding.message}`)
    .join('|')

  return `${filePath}|${diagPart}|${findingPart}`
}

function buildBackgroundDocQuery(
  document: vscode.TextDocument,
  diagnostics: vscode.Diagnostic[],
  findings: MonitorFinding[]
): string {
  const fileName = path.basename(document.uri.fsPath)
  const language = document.languageId
  const importHints = extractImportHints(document)
  const issueText = [
    ...diagnostics.slice(0, 2).map((diag) => diag.message),
    ...findings.slice(0, 2).map((finding) => finding.message),
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return [
    language,
    fileName,
    importHints.slice(0, 3).join(' '),
    issueText,
    'official docs fix',
  ]
    .filter((part) => part.length > 0)
    .join(' ')
    .slice(0, 500)
}

function extractImportHints(document: vscode.TextDocument): string[] {
  const text = document.getText().slice(0, 18_000)
  const imports = new Set<string>()

  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const value = (match[1] ?? '').trim()
    const normalized = normalizeImportToken(value)
    if (normalized) imports.add(normalized)
  }
  for (const match of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const value = (match[1] ?? '').trim()
    const normalized = normalizeImportToken(value)
    if (normalized) imports.add(normalized)
  }
  for (const match of text.matchAll(/^\s*import\s+([A-Za-z0-9_.]+)/gm)) {
    const value = (match[1] ?? '').trim()
    const normalized = normalizeImportToken(value)
    if (normalized) imports.add(normalized)
  }
  for (const match of text.matchAll(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm)) {
    const value = (match[1] ?? '').trim()
    const normalized = normalizeImportToken(value)
    if (normalized) imports.add(normalized)
  }

  return Array.from(imports).slice(0, 6)
}

function normalizeImportToken(value: string): string | undefined {
  if (!value) return undefined
  if (value.startsWith('.')) return undefined
  if (value.startsWith('/')) return undefined
  if (value.startsWith('@types/')) return undefined

  const cleaned = value.trim()
  if (cleaned.startsWith('@')) {
    const parts = cleaned.split('/')
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`
    }
    return cleaned
  }

  const cleanedBase = cleaned.replace(/\/.*/, '').trim()
  if (!cleanedBase) return undefined
  return cleanedBase
}

async function buildAssistantContext(question: string): Promise<AssistantContext> {
  const editor = resolveContextEditor()
  if (!editor) {
    return {
      filePath: 'No active file',
      languageId: 'unknown',
      selectedCode: '',
      surroundingCode: '',
      diagnostics: [],
      findings: [],
      referencedFiles: [],
    }
  }

  const { document, selection } = editor
  const selectedCode = document.getText(selection)
  const surroundingCode = getSurroundingCode(editor)

  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .slice(0, 8)
    .map((diag) => {
      const level =
        diag.severity === vscode.DiagnosticSeverity.Error
          ? 'error'
          : diag.severity === vscode.DiagnosticSeverity.Warning
            ? 'warning'
            : 'info'
      return `[${level}] L${diag.range.start.line + 1}: ${diag.message}`
    })

  const findings = monitorService?.getFindingsForDocument(document).slice(0, 8) ?? []
  const referencedFiles = await collectReferencedFilesForContext(question, document)

  return {
    filePath: document.uri.fsPath,
    languageId: document.languageId,
    selectedCode,
    surroundingCode,
    diagnostics,
    findings,
    referencedFiles,
  }
}

async function collectReferencedFilesForContext(
  question: string,
  activeDocument: vscode.TextDocument
): Promise<ReferencedFileContext[]> {
  const openDocsByPath = new Map<string, vscode.TextDocument>(
    vscode.workspace.textDocuments.map((doc) => [doc.uri.fsPath, doc])
  )

  const fileSpecs: Array<{ filePath: string; source: ReferencedFileContext['source'] }> = []
  const addSpec = (filePath: string, source: ReferencedFileContext['source']): void => {
    if (!filePath) return
    if (fileSpecs.some((spec) => spec.filePath === filePath)) return
    fileSpecs.push({ filePath, source })
  }

  addSpec(activeDocument.uri.fsPath, 'active')

  const visibleDocs = vscode.window.visibleTextEditors
    .map((editor) => editor.document)
    .filter((doc) => doc.uri.scheme === 'file')

  for (const doc of visibleDocs) {
    addSpec(doc.uri.fsPath, doc.uri.fsPath === activeDocument.uri.fsPath ? 'active' : 'visible')
  }

  const mentionedFilePaths = await resolveMentionedFilePaths(question, activeDocument.uri.fsPath)
  for (const path of mentionedFilePaths) {
    addSpec(path, 'mentioned')
  }

  const importedFilePaths = await resolveImportedLocalFilePaths(activeDocument)
  for (const path of importedFilePaths) {
    addSpec(path, 'imported')
  }

  if (shouldIncludeWorkspaceWideContext(question)) {
    const workspaceFilePaths = await resolveWorkspaceWideFilePaths(activeDocument.uri.fsPath)
    for (const path of workspaceFilePaths) {
      addSpec(path, 'workspace')
    }
  }

  const contexts: ReferencedFileContext[] = []
  let totalChars = 0
  for (const spec of fileSpecs.slice(0, MAX_REFERENCED_FILES)) {
    const context = await readReferencedFileContext(spec.filePath, spec.source, openDocsByPath)
    if (!context) continue

    const remaining = MAX_TOTAL_REFERENCED_CHARS - totalChars
    if (remaining <= 0) break

    if (context.content.length > remaining) {
      context.content = context.content.slice(0, remaining)
      context.truncated = true
    }

    totalChars += context.content.length
    contexts.push(context)
  }

  return contexts
}

async function resolveImportedLocalFilePaths(
  activeDocument: vscode.TextDocument
): Promise<string[]> {
  const specifiers = extractLocalImportSpecifiers(activeDocument).slice(
    0,
    MAX_IMPORTED_REFERENCED_FILES
  )
  const resolved: string[] = []

  for (const specifier of specifiers) {
    const path = await resolveRelativeImportCandidate(specifier, activeDocument.uri.fsPath)
    if (!path) continue
    if (resolved.includes(path)) continue
    resolved.push(path)
    if (resolved.length >= MAX_IMPORTED_REFERENCED_FILES) break
  }

  return resolved
}

function extractLocalImportSpecifiers(document: vscode.TextDocument): string[] {
  const text = document.getText().slice(0, 18_000)
  const specifiers = new Set<string>()

  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const specifier = (match[1] ?? '').trim()
    if (specifier.startsWith('.')) {
      specifiers.add(specifier)
    }
  }

  for (const match of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = (match[1] ?? '').trim()
    if (specifier.startsWith('.')) {
      specifiers.add(specifier)
    }
  }

  for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = (match[1] ?? '').trim()
    if (specifier.startsWith('.')) {
      specifiers.add(specifier)
    }
  }

  return Array.from(specifiers)
}

async function resolveRelativeImportCandidate(
  specifier: string,
  activeFilePath: string
): Promise<string | undefined> {
  const cleanSpecifier = specifier.replace(/[?#].*$/, '').trim()
  if (!cleanSpecifier) return undefined

  const activeDirPath = path.dirname(activeFilePath)
  const basePath = path.resolve(activeDirPath, cleanSpecifier)
  const candidates: string[] = [basePath]
  const ext = path.extname(basePath)

  if (!ext) {
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md']
    for (const extension of extensions) {
      candidates.push(`${basePath}${extension}`)
    }
    for (const extension of extensions) {
      candidates.push(path.join(basePath, `index${extension}`))
    }
  }

  for (const candidate of candidates) {
    const uri = vscode.Uri.file(candidate)
    if (await uriExists(uri)) {
      return uri.fsPath
    }
  }

  return undefined
}

function shouldIncludeWorkspaceWideContext(question: string): boolean {
  const normalized = question.trim().toLowerCase()
  if (!normalized) return false

  return (
    /\b(scan|check|review|analy[sz]e|audit|inspect)\b/.test(normalized) &&
    /\b(all|other|whole|entire|workspace|repo|project|codebase)\b/.test(normalized)
  )
}

async function resolveWorkspaceWideFilePaths(activeFilePath: string): Promise<string[]> {
  const candidates = await vscode.workspace.findFiles(
    WORKSPACE_SCAN_INCLUDE_GLOB,
    WORKSPACE_SCAN_EXCLUDE_GLOB,
    120
  )

  const scored = candidates
    .map((uri) => uri.fsPath)
    .filter((filePath) => filePath !== activeFilePath)
    .map((filePath) => ({ filePath, score: scoreWorkspacePath(filePath) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_WORKSPACE_REFERENCED_FILES)

  return scored.map((item) => item.filePath)
}

function scoreWorkspacePath(filePath: string): number {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  let score = 0

  if (normalized.includes('/src/')) score += 6
  if (normalized.includes('/app/')) score += 5
  if (normalized.endsWith('/package.json')) score += 10
  if (normalized.endsWith('/tsconfig.json')) score += 9
  if (normalized.endsWith('/readme.md')) score += 8
  if (/\/(index|main|app)\.(ts|tsx|js|jsx)$/.test(normalized)) score += 7
  if (/\/(api|routes|route|controller|service|hook|hooks)\//.test(normalized)) score += 5

  return score
}

async function resolveMentionedFilePaths(
  question: string,
  activeFilePath: string
): Promise<string[]> {
  const rawCandidates = extractFileCandidates(question)
  if (rawCandidates.length === 0) {
    return []
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
  const resolved: string[] = []

  for (const candidate of rawCandidates) {
    const path = await resolveFileCandidate(candidate, workspaceRoot, activeFilePath)
    if (!path) continue
    if (resolved.includes(path)) continue
    resolved.push(path)
    if (resolved.length >= MAX_REFERENCED_FILES) break
  }

  return resolved
}

function extractFileCandidates(question: string): string[] {
  const candidates = new Set<string>()
  const text = question || ''

  const backtickMatches = text.match(/`([^`]+)`/g) ?? []
  for (const match of backtickMatches) {
    const value = match.slice(1, -1).trim()
    if (looksLikeFileReference(value)) candidates.add(value)
  }

  const atMatches = Array.from(text.matchAll(/@([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g))
  for (const match of atMatches) {
    const value = (match[1] ?? '').trim()
    if (looksLikeFileReference(value)) candidates.add(value)
  }

  const pathMatches = Array.from(text.matchAll(/\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})\b/g))
  for (const match of pathMatches) {
    const value = (match[1] ?? '').trim()
    if (looksLikeFileReference(value)) candidates.add(value)
  }

  return Array.from(candidates)
}

function looksLikeFileReference(candidate: string): boolean {
  if (!candidate) return false
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) return false
  if (candidate.includes('/') || candidate.includes('\\')) return true
  if (/^(dockerfile|makefile|readme|license|tsconfig|package)$/i.test(candidate)) {
    return true
  }
  if (!candidate.includes('.')) return false
  return /[A-Za-z0-9]/.test(candidate)
}

async function resolveFileCandidate(
  candidate: string,
  workspaceRoot: vscode.Uri | undefined,
  activeFilePath: string
): Promise<string | undefined> {
  const normalized = candidate.replace(/^["'`]/, '').replace(/["'`]$/, '').trim()
  if (!normalized) return undefined

  if (normalized.startsWith('/')) {
    const uri = vscode.Uri.file(normalized)
    if (await uriExists(uri)) return uri.fsPath
  }

  if (workspaceRoot) {
    const joined = vscode.Uri.joinPath(
      workspaceRoot,
      normalized.replace(/^\.?\//, '')
    )
    if (await uriExists(joined)) return joined.fsPath
  }

  const activeDirPath = path.dirname(activeFilePath)
  const activeDir = vscode.Uri.file(activeDirPath)
  const nearActive = vscode.Uri.joinPath(activeDir, normalized)
  if (await uriExists(nearActive)) return nearActive.fsPath

  const glob = `**/${normalized}`
  const results = await vscode.workspace.findFiles(
    glob,
    '**/{node_modules,dist,.next,.git,out,build,.turbo,.cache}/**',
    5
  )
  if (results.length > 0) return results[0].fsPath

  const basename = normalized.split('/').pop()
  if (basename && basename !== normalized) {
    const basenameResults = await vscode.workspace.findFiles(
      `**/${basename}`,
      '**/{node_modules,dist,.next,.git,out,build,.turbo,.cache}/**',
      5
    )
    if (basenameResults.length > 0) return basenameResults[0].fsPath
  }

  return undefined
}

async function readReferencedFileContext(
  filePath: string,
  source: ReferencedFileContext['source'],
  openDocsByPath: Map<string, vscode.TextDocument>
): Promise<ReferencedFileContext | undefined> {
  const openDoc = openDocsByPath.get(filePath)
  let doc = openDoc

  if (!doc) {
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
    } catch {
      return undefined
    }
  }

  let content = doc.getText()
  let truncated = false
  if (content.length > MAX_FILE_CONTENT_CHARS) {
    content = `${content.slice(0, MAX_FILE_CONTENT_CHARS)}\n...[truncated]`
    truncated = true
  }

  return {
    filePath: doc.uri.fsPath,
    languageId: doc.languageId,
    source,
    content,
    truncated,
  }
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri)
    return true
  } catch {
    return false
  }
}

function getActiveMonitorFindings(): MonitorFinding[] {
  const editor = resolveContextEditor()
  if (!editor) return []
  return monitorService?.getFindingsForDocument(editor.document).slice(0, 12) ?? []
}

function getSurroundingCode(editor: vscode.TextEditor): string {
  const document = editor.document
  const activeLine = editor.selection.active.line
  const startLine = Math.max(0, activeLine - 40)
  const endLine = Math.min(document.lineCount - 1, activeLine + 40)
  const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length)
  return document.getText(range)
}

function getSelectedText(): string | undefined {
  const editor = resolveContextEditor()
  if (!editor) return undefined

  const text = editor.document.getText(editor.selection).trim()
  return text.length > 0 ? text : undefined
}

function output(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`)
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function isRecoverableConvaiDisconnect(error: unknown): boolean {
  const message = toMessage(error).toLowerCase()
  return (
    message.includes('session disconnected') ||
    message.includes('not connected') ||
    message.includes('connection closed') ||
    message.includes('websocket') ||
    message.includes('timed out waiting for agent response')
  )
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}...`
}

function defaultProjectName(workspaceKey: string): string {
  return workspaceKey.split('/').pop() || 'Current Workspace'
}

function inferEditorLanguageLabel(): string {
  const editor = resolveContextEditor()
  if (!editor) return 'TypeScript'

  const language = editor.document.languageId
  switch (language) {
    case 'typescriptreact':
    case 'javascriptreact':
      return 'React'
    case 'typescript':
      return 'TypeScript'
    case 'javascript':
      return 'JavaScript'
    case 'python':
      return 'Python'
    default:
      return language
  }
}

function resolveContextEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor
  if (active && active.document.uri.scheme === 'file') {
    return active
  }

  return vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.scheme === 'file'
  )
}

interface DerivedProjectHints {
  projectName: string
  stack: string
  summary: string
  docsUrls: string[]
}

interface PackageLikeJson {
  name?: string
  description?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: {
    vscode?: string
  }
}

async function deriveProjectContextHints(
  workspaceKey: string,
  current: ProjectContext | undefined
): Promise<DerivedProjectHints> {
  const folder = vscode.workspace.workspaceFolders?.find(
    (item) => item.uri.fsPath === workspaceKey
  )

  const fallback: DerivedProjectHints = {
    projectName: defaultProjectName(workspaceKey),
    stack: inferEditorLanguageLabel(),
    summary: `Working in ${defaultProjectName(workspaceKey)}. Focus on practical, safe code fixes and docs-backed answers.`,
    docsUrls: uniqueStrings(current?.docsUrls ?? []),
  }

  if (!folder) return fallback

  const stackTags = new Set<string>()
  const docs = new Set<string>(fallback.docsUrls)
  let projectName = fallback.projectName
  let summary = fallback.summary

  const packageJson = await tryReadJsonFile<PackageLikeJson>(folder.uri, 'package.json')
  if (packageJson) {
    if (typeof packageJson.name === 'string' && packageJson.name.trim().length > 0) {
      projectName = packageJson.name.trim()
    }
    if (typeof packageJson.description === 'string' && packageJson.description.trim().length > 0) {
      summary = packageJson.description.trim()
    }

    const allDeps = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    }

    const hasDep = (name: string): boolean => Object.prototype.hasOwnProperty.call(allDeps, name)
    if (hasDep('react') || hasDep('react-dom')) {
      stackTags.add('React')
      docs.add('https://react.dev/')
    }
    if (hasDep('next')) {
      stackTags.add('Next.js')
      docs.add('https://nextjs.org/docs')
    }
    if (hasDep('express')) {
      stackTags.add('Express')
      docs.add('https://expressjs.com/en/4x/api.html')
    }
    if (hasDep('nestjs') || hasDep('@nestjs/core')) {
      stackTags.add('NestJS')
      docs.add('https://docs.nestjs.com/')
    }
    if (hasDep('typescript')) {
      stackTags.add('TypeScript')
      docs.add('https://www.typescriptlang.org/docs/')
    }
    if (hasDep('vue')) {
      stackTags.add('Vue')
      docs.add('https://vuejs.org/guide/introduction.html')
    }
    if (hasDep('svelte')) {
      stackTags.add('Svelte')
      docs.add('https://svelte.dev/docs')
    }
    if (packageJson.engines?.vscode) {
      stackTags.add('VS Code Extension')
      docs.add('https://code.visualstudio.com/api')
    }
  }

  if (await fileExists(folder.uri, 'tsconfig.json')) {
    stackTags.add('TypeScript')
    docs.add('https://www.typescriptlang.org/tsconfig')
  }
  if (await fileExists(folder.uri, 'requirements.txt') || (await fileExists(folder.uri, 'pyproject.toml'))) {
    stackTags.add('Python')
    docs.add('https://docs.python.org/3/')
  }
  if (await fileExists(folder.uri, 'go.mod')) {
    stackTags.add('Go')
    docs.add('https://go.dev/doc/')
  }
  if (await fileExists(folder.uri, 'Cargo.toml')) {
    stackTags.add('Rust')
    docs.add('https://doc.rust-lang.org/book/')
  }

  if (stackTags.size === 0) {
    stackTags.add(fallback.stack)
  }

  const readmeExcerpt = await tryReadFile(folder.uri, 'README.md')
  if (
    summary === fallback.summary &&
    readmeExcerpt &&
    readmeExcerpt.trim().length > 0
  ) {
    const firstMeaningful = readmeExcerpt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#'))
    if (firstMeaningful) {
      summary = truncate(firstMeaningful, 220)
    }
  }

  return {
    projectName,
    stack: Array.from(stackTags).join(', '),
    summary,
    docsUrls: uniqueStrings(Array.from(docs)),
  }
}

async function tryReadJsonFile<T>(
  root: vscode.Uri,
  relativePath: string
): Promise<T | undefined> {
  const text = await tryReadFile(root, relativePath)
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

async function tryReadFile(
  root: vscode.Uri,
  relativePath: string
): Promise<string | undefined> {
  try {
    const uri = vscode.Uri.joinPath(root, relativePath)
    const bytes = await vscode.workspace.fs.readFile(uri)
    return Buffer.from(bytes).toString('utf8')
  } catch {
    return undefined
  }
}

async function fileExists(root: vscode.Uri, relativePath: string): Promise<boolean> {
  try {
    const uri = vscode.Uri.joinPath(root, relativePath)
    await vscode.workspace.fs.stat(uri)
    return true
  } catch {
    return false
  }
}

function parseDocsUrls(input: string): string[] {
  const tokens = input
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  const urls: string[] = []
  for (const token of tokens) {
    try {
      const parsed = new URL(token)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        continue
      }
      urls.push(parsed.toString())
    } catch {
      // ignore invalid tokens; input is validated in UI
    }
  }

  return uniqueStrings(urls)
}

function validateDocsUrlsInput(input: string): string | null {
  const tokens = input
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  for (const token of tokens) {
    try {
      const parsed = new URL(token)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `Invalid URL protocol for "${token}". Use http or https.`
      }
    } catch {
      return `Invalid URL: "${token}"`
    }
  }

  return null
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((item) => item.trim()).filter((item) => item.length > 0))
  )
}

function formatRelativeIso(iso: string): string {
  const date = new Date(iso)
  const deltaMs = Date.now() - date.getTime()
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    const uri = vscode.Uri.parse(url)
    await vscode.env.openExternal(uri)
  } catch {
    vscode.window.showErrorMessage(`Invalid URL: ${url}`)
  }
}

async function maybeSpeak(
  panel: AssistantPanel,
  text: string,
  voiceService: VoiceService
): Promise<void> {
  const config = getConfig()
  if (!config.autoSpeakResponses) return

  try {
    const audioBase64 = await voiceService.synthesize(text)
    if (audioBase64) {
      panel.postAudio(audioBase64, 'audio/mpeg')
      return
    }
    panel.postSystemMessage('ElevenLabs TTS returned empty audio.')
  } catch (error) {
    const message = toMessage(error)
    panel.postSystemMessage(`ElevenLabs TTS failed: ${message}`)
    output(`Voice playback failed: ${message}`)
  }
}
