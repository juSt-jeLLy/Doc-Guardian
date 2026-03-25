import * as vscode from 'vscode'
import type {
  DocSearchResult,
  ProjectContext,
  SessionTurn,
  StoredSession,
} from '../types'

interface StoredState {
  contexts: Record<string, ProjectContext>
  sessions: Record<string, StoredSession[]>
  activeSessionByWorkspace: Record<string, string>
}

const STORAGE_KEY = 'docGuardian.sessionStore.v1'
const MAX_TURNS_PER_SESSION = 200
const MAX_DOC_LOOKUPS_PER_SESSION = 30

export class SessionStore {
  private readonly context: vscode.ExtensionContext
  private state: StoredState

  constructor(context: vscode.ExtensionContext) {
    this.context = context
    this.state = this.context.globalState.get<StoredState>(STORAGE_KEY) ?? {
      contexts: {},
      sessions: {},
      activeSessionByWorkspace: {},
    }
  }

  getWorkspaceKey(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return 'no-workspace'
    return folder.uri.fsPath
  }

  getProjectContext(workspaceKey: string): ProjectContext | undefined {
    const context = this.state.contexts[workspaceKey]
    if (!context) return undefined
    return {
      ...context,
      docsUrls: (context.docsUrls ?? []).filter((url) => typeof url === 'string' && url.trim().length > 0),
    }
  }

  async setProjectContext(
    workspaceKey: string,
    context: Omit<ProjectContext, 'workspaceKey' | 'updatedAt'>
  ): Promise<ProjectContext> {
    const next: ProjectContext = {
      ...context,
      docsUrls: (context.docsUrls ?? []).filter((url) => url.trim().length > 0),
      workspaceKey,
      updatedAt: new Date().toISOString(),
    }
    this.state.contexts[workspaceKey] = next
    await this.persist()
    return next
  }

  getSessions(workspaceKey: string): StoredSession[] {
    return [...(this.state.sessions[workspaceKey] ?? [])].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt)
    )
  }

  async createSession(workspaceKey: string, title?: string): Promise<StoredSession> {
    const session: StoredSession = {
      id: this.createId('sess'),
      title: title?.trim() || this.defaultSessionTitle(workspaceKey),
      workspaceKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turns: [],
      docLookups: [],
    }

    const existing = this.state.sessions[workspaceKey] ?? []
    this.state.sessions[workspaceKey] = [session, ...existing]
    this.state.activeSessionByWorkspace[workspaceKey] = session.id
    await this.persist()
    return session
  }

  async getOrCreateActiveSession(workspaceKey: string): Promise<StoredSession> {
    const sessions = this.state.sessions[workspaceKey] ?? []
    const activeId = this.state.activeSessionByWorkspace[workspaceKey]
    const active = sessions.find((session) => session.id === activeId)
    if (active) return active
    if (sessions.length > 0) {
      this.state.activeSessionByWorkspace[workspaceKey] = sessions[0].id
      await this.persist()
      return sessions[0]
    }
    return this.createSession(workspaceKey)
  }

  async switchActiveSession(
    workspaceKey: string,
    sessionId: string
  ): Promise<StoredSession | undefined> {
    const session = (this.state.sessions[workspaceKey] ?? []).find(
      (item) => item.id === sessionId
    )
    if (!session) return undefined
    this.state.activeSessionByWorkspace[workspaceKey] = session.id
    await this.persist()
    return session
  }

  async appendTurn(
    workspaceKey: string,
    role: SessionTurn['role'],
    text: string
  ): Promise<StoredSession> {
    const session = await this.getOrCreateActiveSession(workspaceKey)
    const target = this.ensureMutableSession(workspaceKey, session.id)
    if (!target) {
      throw new Error('Active session not found.')
    }

    target.turns.push({
      role,
      text,
      createdAt: new Date().toISOString(),
    })
    target.turns = target.turns.slice(-MAX_TURNS_PER_SESSION)
    target.updatedAt = new Date().toISOString()
    await this.persist()
    return target
  }

  async addDocLookup(
    workspaceKey: string,
    query: string,
    results: DocSearchResult[]
  ): Promise<StoredSession> {
    const session = await this.getOrCreateActiveSession(workspaceKey)
    const target = this.ensureMutableSession(workspaceKey, session.id)
    if (!target) {
      throw new Error('Active session not found.')
    }

    target.docLookups.push({
      query,
      results,
      createdAt: new Date().toISOString(),
    })
    target.docLookups = target.docLookups.slice(-MAX_DOC_LOOKUPS_PER_SESSION)
    target.updatedAt = new Date().toISOString()
    await this.persist()
    return target
  }

  getActiveSessionId(workspaceKey: string): string | undefined {
    return this.state.activeSessionByWorkspace[workspaceKey]
  }

  getRecentTurns(workspaceKey: string, count = 8): SessionTurn[] {
    const activeId = this.state.activeSessionByWorkspace[workspaceKey]
    const session = (this.state.sessions[workspaceKey] ?? []).find(
      (item) => item.id === activeId
    )
    if (!session) return []
    return session.turns.slice(-count)
  }

  getRecentDocLookups(
    workspaceKey: string,
    count = 3
  ): Array<{ query: string; topUrls: string[] }> {
    const activeId = this.state.activeSessionByWorkspace[workspaceKey]
    const session = (this.state.sessions[workspaceKey] ?? []).find(
      (item) => item.id === activeId
    )
    if (!session) return []

    return session.docLookups.slice(-count).map((lookup) => ({
      query: lookup.query,
      topUrls: lookup.results.slice(0, 3).map((doc) => doc.url),
    }))
  }

  private ensureMutableSession(
    workspaceKey: string,
    sessionId: string
  ): StoredSession | undefined {
    const sessions = this.state.sessions[workspaceKey] ?? []
    const index = sessions.findIndex((item) => item.id === sessionId)
    if (index < 0) return undefined

    const current = sessions[index]
    const mutable: StoredSession = {
      ...current,
      turns: [...current.turns],
      docLookups: [...current.docLookups],
    }
    sessions[index] = mutable
    this.state.sessions[workspaceKey] = sessions
    return mutable
  }

  private defaultSessionTitle(workspaceKey: string): string {
    const folderName = workspaceKey.split('/').pop() || 'Workspace'
    return `${folderName} session ${new Date().toISOString().slice(0, 10)}`
  }

  private createId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  private async persist(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, this.state)
  }
}
