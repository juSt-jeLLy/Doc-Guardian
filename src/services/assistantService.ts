import { getConfig } from '../config'
import type { AssistantAnswer, AssistantContext, DocSearchResult } from '../types'

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

export class AssistantService {
  async answerQuestion(
    question: string,
    context: AssistantContext,
    docs: DocSearchResult[]
  ): Promise<AssistantAnswer> {
    const cfg = getConfig()
    if (!cfg.openAIApiKey) {
      return this.localAnswer(question, context, docs)
    }

    try {
      const prompt = this.buildPrompt(question, context, docs)
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.openAIApiKey}`,
        },
        body: JSON.stringify({
          model: cfg.openAIModel,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                'You are a pragmatic coding assistant inside VS Code. Give direct, actionable coding help. Reference supplied docs when relevant.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      })

      if (!response.ok) {
        throw new Error(`OpenAI failed (${response.status})`)
      }

      const payload = (await response.json()) as OpenAIResponse
      const content = payload.choices?.[0]?.message?.content?.trim()
      if (!content) throw new Error('Empty model response')

      return {
        answer: content,
        followUps: [
          'Do you want a patch for this file?',
          'Should I suggest tests for this change?',
        ],
      }
    } catch {
      return this.localAnswer(question, context, docs)
    }
  }

  private buildPrompt(
    question: string,
    context: AssistantContext,
    docs: DocSearchResult[]
  ): string {
    const docsBlock = docs
      .map((doc, index) => `${index + 1}. ${doc.title}\n${doc.url}\n${doc.snippet}`)
      .join('\n\n')

    const findings = context.findings
      .map((f) => `- [${f.severity}] ${f.message} (${f.filePath}:${f.line})`)
      .join('\n')

    return [
      `Question: ${question}`,
      `File: ${context.filePath}`,
      `Language: ${context.languageId}`,
      `Diagnostics:\n${context.diagnostics.join('\n') || 'None'}`,
      `Monitor findings:\n${findings || 'None'}`,
      `Selected code:\n${context.selectedCode || '(no selection)'}`,
      `Nearby code:\n${context.surroundingCode}`,
      `Relevant docs:\n${docsBlock || 'No docs found'}`,
      'Return a concise explanation, concrete next steps, and a suggested code snippet if useful.',
    ].join('\n\n')
  }

  private localAnswer(
    question: string,
    context: AssistantContext,
    docs: DocSearchResult[]
  ): AssistantAnswer {
    const topDocs = docs.slice(0, 3)
    const docLines =
      topDocs.length > 0
        ? topDocs.map((d) => `- ${d.title}: ${d.url}`).join('\n')
        : '- No live docs found. Add Firecrawl API key for richer retrieval.'

    const findings = context.findings.slice(0, 4)
    const findingLines =
      findings.length > 0
        ? findings.map((f) => `- [${f.severity}] ${f.message}`).join('\n')
        : '- No urgent monitor findings in current context.'

    const answer = [
      `You asked: ${question}`,
      '',
      'Current context summary:',
      `- File: ${context.filePath}`,
      `- Language: ${context.languageId}`,
      '',
      'Top monitor findings:',
      findingLines,
      '',
      'Best docs to check now:',
      docLines,
      '',
      'Recommended next step:',
      'Apply one fix from findings first, then re-run diagnostics and ask a focused follow-up on the exact error.',
    ].join('\n')

    return {
      answer,
      followUps: ['Want me to focus on the top error only?', 'Should I draft a concrete patch?'],
    }
  }
}
