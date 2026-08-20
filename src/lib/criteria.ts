/**
 * Verifier criteria handling.
 *
 * A criteria document is a plain Markdown file with a `## Ground Truth Note`
 * section (optional) and a `## Criteria` section containing one `### Name`
 * block per criterion. Bundled criteria files ship with the preset; users can
 * also pass a path, a name, or inline criteria objects.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Criterion {
  id: string
  name: string
  description: string
}

export interface CriteriaDocument {
  groundTruthNote: string
  criteria: Criterion[]
}

export type CriteriaArgument =
  | string
  | Record<string, string>
  | Array<string | Partial<Criterion> & { description: string }>
  | Criterion[]

const HTML_COMMENT = /<!--[\s\S]*?-->/g

function slug(text: string): string {
  const value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '')
  return value || 'criterion'
}

function dedupeId(wanted: string, used: Set<string>): string {
  let candidate = wanted
  let counter = 2
  while (used.has(candidate)) {
    candidate = `${wanted}_${counter}`
    counter += 1
  }
  used.add(candidate)
  return candidate
}

/** Parse the criteria Markdown layout used by the preset's bundled files. */
export function parseCriteriaMarkdown(text: string): CriteriaDocument {
  const cleaned = text.replace(HTML_COMMENT, '')
  const lines = cleaned.split(/\r?\n/)

  let groundTruthNote = ''
  let section: 'ground-truth' | 'criteria' | 'other' = 'other'
  const criteria: Criterion[] = []
  const usedIds = new Set<string>()

  let current: Criterion | null = null
  let buffer: string[] = []

  const flush = (): void => {
    const body = buffer.join('\n').trim()
    if (section === 'ground-truth' && groundTruthNote.length === 0) {
      groundTruthNote = body
    } else if (current !== null) {
      current.description = body
      if (body.length > 0) criteria.push(current)
      current = null
    }
    buffer = []
  }

  for (const line of lines) {
    if (line.startsWith('### ') && section === 'criteria') {
      flush()
      const heading = line.slice(4).trim()
      const pinned = heading.match(/^(.*?)\s*\{#([a-zA-Z0-9_-]+)\}\s*$/)
      const name = (pinned?.[1] ?? heading).trim()
      const id = dedupeId(pinned?.[2] ?? slug(name), usedIds)
      current = { id, name, description: '' }
    } else if (line.startsWith('## ') && !line.startsWith('### ')) {
      flush()
      const heading = line.slice(3).trim().toLowerCase()
      section = heading.includes('ground truth')
        ? 'ground-truth'
        : heading.includes('criteri')
          ? 'criteria'
          : 'other'
    } else if (line.startsWith('# ')) {
      continue
    } else {
      buffer.push(line)
    }
  }
  flush()

  if (criteria.length === 0) {
    throw new Error('no criteria found; the file needs a `## Criteria` section with `### Name` blocks')
  }
  const empty = criteria.filter((criterion) => criterion.description.length === 0)
  if (empty.length > 0) {
    throw new Error(`criteria without instructions: ${empty.map((criterion) => criterion.id).join(', ')}`)
  }
  return { groundTruthNote, criteria }
}

function isInlineObject(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize every accepted inline criteria form into criterion objects. */
export function normalizeCriteria(argument: CriteriaArgument): Criterion[] {
  let rows: Array<string | Partial<Criterion>> = []
  if (isInlineObject(argument)) {
    rows = Object.entries(argument).map(([name, description]) => ({ name, description }))
  } else {
    rows = argument as Array<string | Partial<Criterion>>
  }

  if (rows.length === 0) {
    throw new Error('criteria must not be empty')
  }

  const used = new Set<string>()
  return rows.map((row, index) => {
    const name = typeof row === 'string' ? row : String(row.name ?? '')
    const description = typeof row === 'string' ? row : String(row.description ?? '')
    if (description.length === 0) {
      throw new Error(`criteria[${index}] is missing a description`)
    }
    const fallbackName = name.length > 0 ? name : slug(description)
    const id = typeof row === 'object' && typeof row.id === 'string' && row.id.length > 0
      ? dedupeId(row.id, used)
      : dedupeId(slug(fallbackName), used)
    return { id, name: fallbackName, description }
  })
}

const BUNDLED_CRITERIA_DIR = fileURLToPath(
  new URL('../../preset/llm-as-a-verifier/criteria/', import.meta.url),
)

async function readCriteriaFile(pathOrName: string, cwd: string): Promise<CriteriaDocument> {
  const candidates: string[] = []
  if (isAbsolute(pathOrName)) {
    candidates.push(pathOrName)
  } else {
    const withExtension = pathOrName.endsWith('.md') ? pathOrName : `${pathOrName}.md`
    candidates.push(resolve(cwd, pathOrName), resolve(cwd, withExtension))
    if (pathOrName === withExtension) {
      candidates.push(resolve(cwd, 'criteria', withExtension))
    } else {
      candidates.push(resolve(cwd, 'criteria', withExtension))
    }
    candidates.push(resolve(BUNDLED_CRITERIA_DIR, withExtension))
  }

  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return parseCriteriaMarkdown(await readFile(candidate, 'utf8'))
    } catch (error) {
      lastError = error
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
  }
  throw new Error(`criteria file not found: ${pathOrName} (looked in the workspace and the preset criteria folder)`, {
    cause: lastError,
  })
}

/** Resolve a criteria argument into a canonical document. */
export async function resolveCriteria(
  argument: CriteriaArgument,
  cwd: string,
): Promise<CriteriaDocument> {
  if (typeof argument === 'string') {
    return readCriteriaFile(argument, cwd)
  }
  return { groundTruthNote: '', criteria: normalizeCriteria(argument) }
}

export const BUNDLED_CRITERIA_NAMES = ['general', 'terminal_bench', 'swe_bench', 'medagentbench']
