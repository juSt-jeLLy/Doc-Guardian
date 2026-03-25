import { Conversation, type TextConversation } from '@elevenlabs/client'
import WebSocketImpl from 'ws'
import { getConfig } from '../config'
import type { AssistantContext, DocSearchResult, MonitorFinding } from '../types'

type ConvaiStatus = 'disconnected' | 'connecting' | 'connected' | 'disconnecting'

interface ConvaiServiceOptions {
  getCodeContext: () => Promise<AssistantContext> | AssistantContext
  searchDocs: (query: string) => Promise<DocSearchResult[]>
  getMonitorFindings: () => MonitorFinding[]
  onAssistantMessage: (text: string) => Promise<void> | void
  onSystemMessage: (text: string) => void
  onDocs?: (query: string, results: DocSearchResult[]) => void
  onFindings?: (findings: MonitorFinding[]) => void
  onStatusChange?: (status: ConvaiStatus) => void
}

interface SignedUrlResponse {
  signed_url?: string
}

interface PendingTurn {
  resolve: (text: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const TURN_TIMEOUT_MS = 45_000

export class ConvaiService {
  private readonly options: ConvaiServiceOptions
  private conversation: TextConversation | undefined
  private connectPromise: Promise<void> | undefined
  private pendingTurns: PendingTurn[] = []

  constructor(options: ConvaiServiceOptions) {
    this.options = options
    this.ensureBrowserCompatGlobals()
    this.ensureWebSocketPolyfill()
  }

  async ensureSession(): Promise<void> {
    if (this.conversation?.isOpen()) {
      return
    }

    if (this.connectPromise) {
      await this.connectPromise
      return
    }

    this.connectPromise = this.startSession()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = undefined
    }
  }

  async ask(question: string): Promise<string> {
    const text = question.trim()
    if (!text) {
      throw new Error('Question cannot be empty.')
    }

    await this.ensureSession()

    const convo = this.conversation
    if (!convo || !convo.isOpen()) {
      throw new Error('ConvAI session is not connected.')
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTurns = this.pendingTurns.filter((turn) => turn !== pendingTurn)
        reject(new Error('Timed out waiting for agent response.'))
      }, TURN_TIMEOUT_MS)

      const pendingTurn: PendingTurn = { resolve, reject, timer }
      this.pendingTurns.push(pendingTurn)

      try {
        convo.sendUserMessage(text)
      } catch (error) {
        clearTimeout(timer)
        this.pendingTurns = this.pendingTurns.filter((turn) => turn !== pendingTurn)
        const message =
          error instanceof Error ? error.message : 'Failed to send message to agent.'
        reject(new Error(message))
      }
    })
  }

  async updateContext(text: string): Promise<void> {
    const normalized = text.trim()
    if (!normalized) return

    await this.ensureSession()
    const convo = this.conversation
    if (!convo || !convo.isOpen()) {
      throw new Error('ConvAI session is not connected.')
    }

    convo.sendContextualUpdate(normalized)
  }

  async endSession(): Promise<void> {
    const convo = this.conversation
    this.conversation = undefined
    this.rejectAllPendingTurns('Conversation ended.')

    if (!convo) {
      return
    }

    try {
      await convo.endSession()
    } catch {
      // Ignore shutdown errors to keep extension stable.
    }
  }

  dispose(): void {
    void this.endSession()
  }

  private async startSession(): Promise<void> {
    const cfg = getConfig()

    if (!cfg.elevenLabsAgentId) {
      throw new Error('Missing ElevenLabs agent id.')
    }

    const sessionOptions = {
      textOnly: true as const,
      connectionType: 'websocket' as const,
      clientTools: this.buildClientTools(),
      onConnect: () => {
        this.options.onSystemMessage('ConvAI connected.')
      },
      onDisconnect: () => {
        this.options.onSystemMessage('ConvAI disconnected.')
        this.options.onStatusChange?.('disconnected')
        this.conversation = undefined
        this.rejectAllPendingTurns('ConvAI session disconnected.')
      },
      onStatusChange: (payload: { status: ConvaiStatus }) => {
        this.options.onStatusChange?.(payload.status)
      },
      onError: (message: string) => {
        this.options.onSystemMessage(`ConvAI error: ${message}`)
      },
      onMessage: (payload: { source: 'user' | 'ai'; role: 'user' | 'agent'; message: string }) => {
        if (payload.source !== 'ai' && payload.role !== 'agent') {
          return
        }

        const message = payload.message?.trim()
        if (!message) {
          return
        }

        void this.options.onAssistantMessage(message)
        this.resolvePendingTurn(message)
      },
      onUnhandledClientToolCall: (toolCall: { tool_name: string }) => {
        this.options.onSystemMessage(
          `Unhandled client tool call: ${toolCall.tool_name}`
        )
      },
    }

    const signedUrl = await this.getSignedUrl(
      cfg.elevenLabsAgentId,
      cfg.elevenLabsApiKey
    )

    if (signedUrl) {
      this.conversation = await Conversation.startSession({
        ...sessionOptions,
        signedUrl,
      })
      return
    }

    this.conversation = await Conversation.startSession({
      ...sessionOptions,
      agentId: cfg.elevenLabsAgentId,
    })
  }

  private buildClientTools(): Record<string, (parameters: unknown) => Promise<string>> {
    return {
      get_code_context: async () => {
        const context = await this.options.getCodeContext()
        const payload = {
          file_path: context.filePath,
          language: context.languageId,
          selected_code: this.truncate(context.selectedCode, 4_000),
          surrounding_code: this.truncate(context.surroundingCode, 8_000),
          diagnostics: context.diagnostics,
          referenced_files: context.referencedFiles.map((file) => ({
            file_path: file.filePath,
            language: file.languageId,
            source: file.source,
            truncated: file.truncated,
            content: this.truncate(file.content, 12_000),
          })),
          monitor_findings: context.findings.map((finding) => ({
            severity: finding.severity,
            message: finding.message,
            file_path: finding.filePath,
            line: finding.line,
            rule: finding.rule,
            source: finding.source,
          })),
        }
        return JSON.stringify(payload)
      },

      search_docs: async (parameters: unknown) => {
        const query = this.extractSearchQuery(parameters)
        if (!query) {
          return JSON.stringify({
            error: 'query is required',
            results: [],
          })
        }

        const results = await this.options.searchDocs(query)
        this.options.onDocs?.(query, results)

        return JSON.stringify({
          query,
          results: results.map((doc) => ({
            title: doc.title,
            url: doc.url,
            snippet: doc.snippet,
            source: doc.source,
          })),
        })
      },

      get_monitor_findings_v5: async () => {
        const findings = this.options.getMonitorFindings()
        this.options.onFindings?.(findings)

        return JSON.stringify({
          findings: findings.map((finding) => ({
            severity: finding.severity,
            message: finding.message,
            file_path: finding.filePath,
            line: finding.line,
            rule: finding.rule,
            source: finding.source,
            detected_at: finding.createdAt,
          })),
          count: findings.length,
          high_severity_count: findings.filter((f) => f.severity === 'high').length,
        })
      },
    }
  }

  private resolvePendingTurn(message: string): void {
    const next = this.pendingTurns.shift()
    if (!next) {
      return
    }

    clearTimeout(next.timer)
    next.resolve(message)
  }

  private rejectAllPendingTurns(reason: string): void {
    const turns = this.pendingTurns.splice(0, this.pendingTurns.length)
    for (const turn of turns) {
      clearTimeout(turn.timer)
      turn.reject(new Error(reason))
    }
  }

  private extractSearchQuery(parameters: unknown): string {
    if (typeof parameters === 'string') {
      return parameters.trim()
    }

    if (!parameters || typeof parameters !== 'object') {
      return ''
    }

    const payload = parameters as Record<string, unknown>
    const candidates = [
      payload.query,
      payload.question,
      payload.search_query,
      payload.topic,
    ]

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim()
      }
    }

    return ''
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text
    }
    return `${text.slice(0, maxChars)}\n...[truncated]`
  }

  private async getSignedUrl(
    agentId: string,
    apiKey: string
  ): Promise<string | undefined> {
    if (!apiKey.trim()) {
      return undefined
    }

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': apiKey,
          },
        }
      )

      if (!response.ok) {
        return undefined
      }

      const payload = (await response.json()) as SignedUrlResponse
      if (typeof payload.signed_url !== 'string' || payload.signed_url.length === 0) {
        return undefined
      }

      return payload.signed_url
    } catch {
      return undefined
    }
  }

  private ensureWebSocketPolyfill(): void {
    if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined') {
      return
    }
    ;(globalThis as { WebSocket?: unknown }).WebSocket = WebSocketImpl as unknown
  }

  private ensureBrowserCompatGlobals(): void {
    const root = globalThis as unknown as {
      window?: Record<string, unknown>
      navigator?: Record<string, unknown>
      btoa?: (value: string) => string
      atob?: (value: string) => string
    }

    if (typeof root.window === 'undefined') {
      root.window = {}
    }

    const windowLike = root.window

    if (typeof root.navigator === 'undefined') {
      root.navigator = {}
    }

    const navigatorLike = root.navigator

    if (typeof navigatorLike.userAgent !== 'string' || navigatorLike.userAgent.length === 0) {
      navigatorLike.userAgent = 'vscode-doc-guardian/1.0'
    }
    if (typeof navigatorLike.product !== 'string') {
      navigatorLike.product = 'VSCode'
    }
    if (typeof navigatorLike.onLine !== 'boolean') {
      navigatorLike.onLine = true
    }

    if (typeof windowLike.navigator === 'undefined') {
      windowLike.navigator = navigatorLike
    }

    if (typeof windowLike.addEventListener !== 'function') {
      windowLike.addEventListener = () => {}
    }
    if (typeof windowLike.removeEventListener !== 'function') {
      windowLike.removeEventListener = () => {}
    }

    if (typeof root.btoa !== 'function') {
      root.btoa = (value: string) => Buffer.from(value, 'binary').toString('base64')
    }
    if (typeof root.atob !== 'function') {
      root.atob = (value: string) => Buffer.from(value, 'base64').toString('binary')
    }
  }
}
