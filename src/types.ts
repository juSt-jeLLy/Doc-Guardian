export type FindingSeverity = 'low' | 'medium' | 'high'

export interface DocSearchResult {
  title: string
  url: string
  snippet: string
  source: 'web' | 'news' | 'unknown'
}

export interface MonitorFinding {
  id: string
  filePath: string
  line: number
  message: string
  severity: FindingSeverity
  rule: string
  source: 'rule' | 'diagnostic'
  createdAt: string
}

export interface AssistantContext {
  filePath: string
  languageId: string
  selectedCode: string
  surroundingCode: string
  diagnostics: string[]
  findings: MonitorFinding[]
  referencedFiles: ReferencedFileContext[]
}

export interface ReferencedFileContext {
  filePath: string
  languageId: string
  source: 'active' | 'visible' | 'mentioned' | 'imported' | 'workspace'
  content: string
  truncated: boolean
}

export interface AssistantAnswer {
  answer: string
  followUps: string[]
}

export interface ProjectContext {
  projectName: string
  stack: string
  summary: string
  docsUrls?: string[]
  workspaceKey: string
  updatedAt: string
}

export interface SessionTurn {
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: string
}

export interface SessionDocLookup {
  query: string
  results: DocSearchResult[]
  createdAt: string
}

export interface StoredSession {
  id: string
  title: string
  workspaceKey: string
  createdAt: string
  updatedAt: string
  turns: SessionTurn[]
  docLookups: SessionDocLookup[]
}

export interface WebviewAskMessage {
  type: 'ask'
  question: string
}

export interface WebviewSearchMessage {
  type: 'searchDocs'
  query: string
}

export interface WebviewReadyMessage {
  type: 'ready'
}

export interface WebviewOpenUrlMessage {
  type: 'openUrl'
  url: string
}

export interface WebviewSetContextMessage {
  type: 'setContext'
}

export interface WebviewNewSessionMessage {
  type: 'newSession'
}

export interface WebviewSwitchSessionMessage {
  type: 'switchSession'
}

export interface WebviewRequestPanelStateMessage {
  type: 'requestPanelState'
}

export interface WebviewSaveContextMessage {
  type: 'saveContext'
  projectName: string
  stack: string
  summary: string
  docsUrls: string
}

export interface WebviewCreateSessionInlineMessage {
  type: 'createSessionInline'
  title?: string
}

export interface WebviewSwitchSessionInlineMessage {
  type: 'switchSessionInline'
  sessionId: string
}

export type WebviewIncomingMessage =
  | WebviewAskMessage
  | WebviewSearchMessage
  | WebviewOpenUrlMessage
  | WebviewSetContextMessage
  | WebviewNewSessionMessage
  | WebviewSwitchSessionMessage
  | WebviewRequestPanelStateMessage
  | WebviewSaveContextMessage
  | WebviewCreateSessionInlineMessage
  | WebviewSwitchSessionInlineMessage
  | WebviewReadyMessage
