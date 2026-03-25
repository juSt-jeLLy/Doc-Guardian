import * as vscode from 'vscode'
import { BUILTIN_API_KEYS, BUILTIN_DEFAULTS } from './secrets'

const SECTION = 'docGuardian'

export interface GuardianConfig {
  firecrawlApiKey: string
  openAIApiKey: string
  openAIModel: string
  elevenLabsApiKey: string
  elevenLabsVoiceId: string
  elevenLabsAgentId: string
  autoSpeakResponses: boolean
  maxDocsPerSearch: number
  enableLiveMonitoring: boolean
  monitorDebounceMs: number
  showPopupsForAlerts: boolean
  enableBackgroundDocWatch: boolean
  backgroundDocWatchDebounceMs: number
  backgroundDocWatchMinIntervalMs: number
  enableWorkspaceBackgroundDocWatch: boolean
  workspaceBackgroundDocWatchDebounceMs: number
  workspaceBackgroundDocWatchMinIntervalMs: number
}

export function getConfig(): GuardianConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  return {
    firecrawlApiKey:
      cfg.get<string>('firecrawlApiKey', '').trim() || BUILTIN_API_KEYS.firecrawl,
    openAIApiKey: cfg.get<string>('openAIApiKey', '').trim(),
    openAIModel: cfg.get<string>('openAIModel', 'gpt-4.1-mini').trim(),
    elevenLabsApiKey:
      cfg.get<string>('elevenLabsApiKey', '').trim() || BUILTIN_API_KEYS.elevenLabs,
    elevenLabsVoiceId:
      cfg.get<string>('elevenLabsVoiceId', '').trim() || BUILTIN_DEFAULTS.elevenLabsVoiceId,
    elevenLabsAgentId:
      cfg.get<string>('elevenLabsAgentId', '').trim() || BUILTIN_API_KEYS.elevenLabsAgentId,
    autoSpeakResponses: cfg.get<boolean>('autoSpeakResponses', true),
    maxDocsPerSearch: cfg.get<number>('maxDocsPerSearch', 5),
    enableLiveMonitoring: cfg.get<boolean>('enableLiveMonitoring', true),
    monitorDebounceMs: cfg.get<number>('monitorDebounceMs', 1200),
    showPopupsForAlerts: cfg.get<boolean>('showPopupsForAlerts', true),
    enableBackgroundDocWatch: cfg.get<boolean>('enableBackgroundDocWatch', true),
    backgroundDocWatchDebounceMs: cfg.get<number>('backgroundDocWatchDebounceMs', 4500),
    backgroundDocWatchMinIntervalMs: cfg.get<number>('backgroundDocWatchMinIntervalMs', 90_000),
    enableWorkspaceBackgroundDocWatch: cfg.get<boolean>('enableWorkspaceBackgroundDocWatch', true),
    workspaceBackgroundDocWatchDebounceMs: cfg.get<number>(
      'workspaceBackgroundDocWatchDebounceMs',
      12_000
    ),
    workspaceBackgroundDocWatchMinIntervalMs: cfg.get<number>(
      'workspaceBackgroundDocWatchMinIntervalMs',
      180_000
    ),
  }
}
