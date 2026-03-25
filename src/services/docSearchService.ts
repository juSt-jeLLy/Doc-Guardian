import { getConfig } from '../config'
import type { DocSearchResult } from '../types'

interface FirecrawlResult {
  title?: string
  url?: string
  description?: string
}

interface FirecrawlResponse {
  data?: FirecrawlResult[]
  web?: FirecrawlResult[]
  news?: FirecrawlResult[]
}

export class DocSearchService {
  private cache = new Map<string, DocSearchResult[]>()

  async searchDocs(query: string): Promise<DocSearchResult[]> {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) return []

    const cached = this.cache.get(normalizedQuery)
    if (cached) return cached

    const config = getConfig()
    if (!config.firecrawlApiKey) {
      return this.fallbackDocs(normalizedQuery)
    }

    try {
      const response = await fetch('https://api.firecrawl.dev/v2/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.firecrawlApiKey}`,
        },
        body: JSON.stringify({
          query: normalizedQuery,
          limit: config.maxDocsPerSearch,
          sources: ['web', 'news'],
        }),
      })

      if (!response.ok) {
        throw new Error(`Firecrawl search failed (${response.status})`)
      }

      const payload = (await response.json()) as FirecrawlResponse
      const merged = [
        ...(Array.isArray(payload.data) ? payload.data : []),
        ...(Array.isArray(payload.web) ? payload.web : []),
        ...(Array.isArray(payload.news) ? payload.news : []),
      ]

      const deduped = this.normalizeAndDeduplicate(merged).slice(0, config.maxDocsPerSearch)
      this.cache.set(normalizedQuery, deduped)
      return deduped
    } catch {
      return this.fallbackDocs(normalizedQuery)
    }
  }

  private normalizeAndDeduplicate(raw: FirecrawlResult[]): DocSearchResult[] {
    const seen = new Set<string>()
    const results: DocSearchResult[] = []

    for (const item of raw) {
      const url = (item.url ?? '').trim()
      const title = (item.title ?? 'Untitled').trim()
      if (!url || seen.has(url)) continue
      seen.add(url)

      results.push({
        title,
        url,
        snippet: (item.description ?? '').trim(),
        source: 'web',
      })
    }

    return results
  }

  private fallbackDocs(query: string): DocSearchResult[] {
    const lower = query.toLowerCase()
    const docs: DocSearchResult[] = []

    if (lower.includes('react')) {
      docs.push({
        title: 'React Docs',
        url: 'https://react.dev/',
        snippet: 'Official React documentation and API reference.',
        source: 'web',
      })
    }

    if (lower.includes('typescript') || lower.includes('ts')) {
      docs.push({
        title: 'TypeScript Handbook',
        url: 'https://www.typescriptlang.org/docs/',
        snippet: 'Language docs, compiler options, and type-system guides.',
        source: 'web',
      })
    }

    if (lower.includes('node') || lower.includes('express')) {
      docs.push({
        title: 'Node.js Docs',
        url: 'https://nodejs.org/en/docs',
        snippet: 'Node.js APIs and runtime documentation.',
        source: 'web',
      })
    }

    if (docs.length === 0) {
      docs.push({
        title: 'Configure Firecrawl API Key',
        url: 'https://docs.firecrawl.dev/introduction',
        snippet:
          'Set docGuardian.firecrawlApiKey in VS Code settings to enable live docs retrieval from the web.',
        source: 'unknown',
      })
    }

    this.cache.set(query, docs)
    return docs
  }
}
