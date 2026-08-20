/**
 * Workspace-local JSON score cache.
 *
 * Verification comparisons are expensive and deterministic, so successful
 * comparisons are persisted under a content-derived key. The file is written
 * atomically (temp file + rename) so an interrupted run never corrupts the
 * cache.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ScoreCacheEntry {
  scoreA: number
  scoreB: number
}

type ScoreCacheData = Record<string, ScoreCacheEntry>

export interface ScoreCacheStats {
  path: string
  entries: number
  hits: number
}

export class ScoreCache {
  private data: ScoreCacheData = {}
  private hits = 0
  private loaded = false

  constructor(private readonly filePath: string) {}

  key(parts: unknown[]): string {
    const hash = createHash('sha256')
    hash.update(JSON.stringify(parts))
    return hash.digest('hex').slice(0, 32)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as ScoreCacheData
      if (typeof parsed === 'object' && parsed !== null) this.data = parsed
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
  }

  async get(key: string): Promise<ScoreCacheEntry | undefined> {
    await this.ensureLoaded()
    const entry = this.data[key]
    if (entry !== undefined) this.hits += 1
    return entry
  }

  async set(key: string, entry: ScoreCacheEntry): Promise<void> {
    await this.ensureLoaded()
    this.data[key] = entry
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = join(
      dirname(this.filePath),
      `.${this.filePath.split('/').pop() ?? 'cache'}.${process.pid}.${Date.now()}.tmp`,
    )
    await writeFile(temporary, JSON.stringify(this.data), 'utf8')
    await rename(temporary, this.filePath)
  }

  stats(): ScoreCacheStats {
    return {
      path: this.filePath,
      entries: Object.keys(this.data).length,
      hits: this.hits,
    }
  }

  get enabled(): boolean {
    return this.filePath.length > 0
  }
}

export function defaultCachePath(cwd: string): string {
  return join(cwd, '.dsh-verifier-cache.json')
}
