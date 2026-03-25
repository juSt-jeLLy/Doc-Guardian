import * as vscode from 'vscode'
import { getConfig } from '../config'
import type { MonitorFinding } from '../types'
import { DebounceMap } from '../utils/debounce'

interface MonitorOptions {
  onFindings: (findings: MonitorFinding[]) => void
}

export class CodeMonitorService implements vscode.Disposable {
  private disposables: vscode.Disposable[] = []
  private readonly debouncer = new DebounceMap()
  private readonly findingsByFile = new Map<string, MonitorFinding[]>()
  private readonly options: MonitorOptions

  constructor(options: MonitorOptions) {
    this.options = options
  }

  start(): void {
    if (!getConfig().enableLiveMonitoring) {
      return
    }

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const uri = event.document.uri.toString()
        this.debouncer.schedule(uri, getConfig().monitorDebounceMs, () => {
          void this.analyzeDocument(event.document)
        })
      })
    )

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.analyzeDocument(document)
      })
    )

    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((event) => {
        for (const uri of event.uris) {
          const doc = vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === uri.toString()
          )
          if (!doc) continue
          this.debouncer.schedule(uri.toString(), getConfig().monitorDebounceMs, () => {
            void this.analyzeDocument(doc)
          })
        }
      })
    )

    for (const doc of vscode.workspace.textDocuments) {
      void this.analyzeDocument(doc)
    }
  }

  getFindingsForFile(filePath: string): MonitorFinding[] {
    return this.findingsByFile.get(filePath) ?? []
  }

  getFindingsForDocument(document: vscode.TextDocument): MonitorFinding[] {
    return this.findingsByFile.get(document.uri.fsPath) ?? []
  }

  async analyzeDocument(document: vscode.TextDocument): Promise<void> {
    if (document.isUntitled) return
    if (document.uri.scheme !== 'file') return

    const findings: MonitorFinding[] = []
    const text = document.getText()
    const lines = text.split(/\r?\n/)

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const lineNo = index + 1

      if (/\bany\b/.test(line) && /(ts|tsx|js|jsx)/.test(document.languageId)) {
        findings.push(this.createFinding(document, lineNo, 'Avoid broad any type when possible.', 'no-any', 'medium', 'rule'))
      }

      if (/@ts-ignore/.test(line)) {
        findings.push(
          this.createFinding(
            document,
            lineNo,
            'Found @ts-ignore. Validate if this can be replaced with a typed fix.',
            'ts-ignore',
            'high',
            'rule'
          )
        )
      }

      if (/console\.log\(/.test(line) && !/eslint-disable-next-line/.test(line)) {
        findings.push(
          this.createFinding(
            document,
            lineNo,
            'console.log detected. Remove or gate debug logging before merge.',
            'console-log',
            'low',
            'rule'
          )
        )
      }

      if (/\bTODO\b|\bFIXME\b/i.test(line)) {
        findings.push(
          this.createFinding(
            document,
            lineNo,
            'TODO/FIXME present. Confirm this is tracked outside code comments.',
            'todo-fixme',
            'low',
            'rule'
          )
        )
      }

      if (/\beval\(/.test(line)) {
        findings.push(
          this.createFinding(
            document,
            lineNo,
            'eval detected. Prefer safe parsing or explicit logic to avoid security risk.',
            'no-eval',
            'high',
            'rule'
          )
        )
      }
    }

    if (lines.length > 800) {
      findings.push(
        this.createFinding(
          document,
          1,
          `File has ${lines.length} lines. Consider splitting into smaller modules.`,
          'max-file-lines',
          'medium',
          'rule'
        )
      )
    }

    const diagnostics = vscode.languages.getDiagnostics(document.uri)
    const topDiagnostics = diagnostics
      .filter((diag) =>
        diag.severity === vscode.DiagnosticSeverity.Error ||
        diag.severity === vscode.DiagnosticSeverity.Warning
      )
      .slice(0, 5)

    for (const diag of topDiagnostics) {
      findings.push(
        this.createFinding(
          document,
          diag.range.start.line + 1,
          diag.message,
          'diagnostic',
          diag.severity === vscode.DiagnosticSeverity.Error ? 'high' : 'medium',
          'diagnostic'
        )
      )
    }

    const deduped = this.dedupe(findings)
    this.findingsByFile.set(document.uri.fsPath, deduped)

    if (deduped.length > 0) {
      this.options.onFindings(deduped)
    }
  }

  private createFinding(
    document: vscode.TextDocument,
    line: number,
    message: string,
    rule: string,
    severity: MonitorFinding['severity'],
    source: MonitorFinding['source']
  ): MonitorFinding {
    return {
      id: `${document.uri.fsPath}:${line}:${rule}`,
      filePath: document.uri.fsPath,
      line,
      message,
      rule,
      severity,
      source,
      createdAt: new Date().toISOString(),
    }
  }

  private dedupe(findings: MonitorFinding[]): MonitorFinding[] {
    const seen = new Set<string>()
    const output: MonitorFinding[] = []

    for (const finding of findings) {
      if (seen.has(finding.id)) continue
      seen.add(finding.id)
      output.push(finding)
    }

    return output.slice(0, 12)
  }

  dispose(): void {
    this.debouncer.clearAll()
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    this.disposables = []
  }
}
