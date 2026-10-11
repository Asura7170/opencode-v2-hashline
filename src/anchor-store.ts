import { Database } from "bun:sqlite"

export interface AnchorRow {
  anchor: string
  line: number
  content: string
}

export interface AnchorWarning {
  code: string
  message: string
}

export interface ServeResult {
  rows: AnchorRow[]
  warnings: AnchorWarning[]
}

export class AnchorStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`)
    this.name = "AnchorStoreError"
    this.code = code
  }
}

/** Fila cruda de la tabla files (bun:sqlite devuelve unknown). */
interface FileRow {
  path: string
  owner: string
  anchors: string
  prev: string | null
  seq: number
  dirty: number
}

/** Código de error del SO (ENOENT, EISDIR…) sin `any`. */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : undefined
}

export class StaleAnchorError extends AnchorStoreError {
  readonly rows: AnchorRow[]
  constructor(message: string, rows: AnchorRow[]) {
    super("E_ANCHOR_STALE", message)
    this.name = "StaleAnchorError"
    this.rows = rows
  }
}

export interface AnchorStoreOptions {
  sessionId: string
  storePath: string
  maxAnchors?: number
  maxFileBytes?: number
  excludes?: string[]
}

export interface ResolvedAnchor {
  line: number
  content: string
}

export interface ResolvedRange {
  startLine: number
  endLine: number
}

export interface AnchorStore {
  serve(filePath: string, content: string): ServeResult
  commit(filePath: string, newContent: string, opts?: { keepShadow?: boolean }): ServeResult
  resolve(filePath: string, anchor: string): ResolvedAnchor
  resolveRange(filePath: string, startAnchor: string, endAnchor: string): ResolvedRange
  undoShadow(filePath: string): string[] | null
  restoreShadow(filePath: string, diskLines: string[] | null): ServeResult
  close(): void
}

interface LineAlloc {
  anchor: string
  content: string
}

interface FileEntry {
  owner: string
  lines: LineAlloc[]
  prev: string[] | null // sombra para el undo single-level de #7
  seq: number
  dirty: boolean // true si el disco cambió sin commit (stale para el undo de #7)
}

// Excludes vigentes de v1 (referencia, no port) + rechazo binario/imágenes aparte.
export const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.bundle.js",
  "**/*.map",
]

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
  ".avif",
])

function globToRegExp(pattern: string): RegExp {
  let out = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*"
        i++
        if (pattern[i + 1] === "/") i++
      } else {
        out += "[^/]*"
      }
    } else if (c === "?") {
      out += "[^/]"
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/, "\\$&")
    }
  }
  return new RegExp(`${out}$`)
}

function isExcluded(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  return patterns.some((p) => globToRegExp(p).test(normalized))
}

function randomAnchor(): string {
  const bytes = new Uint32Array(2)
  crypto.getRandomValues(bytes)
  let n = (bytes[0] * 0x100000000 + bytes[1]) % 456_976 // 26^4
  let s = ""
  for (let i = 0; i < 4; i++) {
    s = String.fromCharCode(97 + (n % 26)) + s
    n = Math.floor(n / 26)
  }
  return s
}

export function createAnchorStore(opts: AnchorStoreOptions): AnchorStore {
  const maxFileBytes = opts.maxFileBytes ?? 1_048_576
  // shortcut: default sin calibrar; el ticket de config lo hará tunable.
  const maxAnchors = opts.maxAnchors ?? 4096
  const excludes = opts.excludes ?? DEFAULT_EXCLUDES
  const db = new Database(opts.storePath)
  db.exec(
    "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, owner TEXT NOT NULL, anchors TEXT NOT NULL, prev TEXT, seq INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0)",
  )
  try {
    db.exec("ALTER TABLE files ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0")
  } catch {
    // La columna ya existe en sidecars creados por esta versión.
  }
  const files = new Map<string, FileEntry>()
  const used = new Set<string>()
  let clock = 0
  for (const row of db
    .query("SELECT path, owner, anchors, prev, seq, dirty FROM files")
    .all() as FileRow[]) {
    const lines = JSON.parse(row.anchors) as LineAlloc[]
    files.set(row.path, {
      owner: row.owner,
      lines,
      prev: row.prev ? (JSON.parse(row.prev) as string[]) : null,
      seq: row.seq,
      dirty: row.dirty === 1,
    })
    for (const l of lines) used.add(l.anchor)
    clock = Math.max(clock, row.seq)
  }
  let totalAnchors = used.size
  const persist = db.prepare(
    "INSERT OR REPLACE INTO files (path, owner, anchors, prev, seq, dirty) VALUES (?, ?, ?, ?, ?, ?)",
  )
  const forget = db.prepare("DELETE FROM files WHERE path = ?")

  function save(path: string, entry: FileEntry): void {
    persist.run(
      path,
      entry.owner,
      JSON.stringify(entry.lines),
      entry.prev ? JSON.stringify(entry.prev) : null,
      entry.seq,
      entry.dirty ? 1 : 0,
    )
  }

  function checkGuards(filePath: string, content: string): void {
    if (isExcluded(filePath, excludes)) {
      throw new AnchorStoreError("E_PATH_EXCLUDED", `Path excluido: "${filePath}"`)
    }
    if (Buffer.byteLength(content, "utf-8") > maxFileBytes) {
      throw new AnchorStoreError(
        "E_FILE_OVERSIZE",
        `Archivo excede ${maxFileBytes} bytes: "${filePath}"`,
      )
    }
    const lower = filePath.toLowerCase()
    const dot = lower.lastIndexOf(".")
    if (dot >= 0 && IMAGE_EXTENSIONS.has(lower.slice(dot))) {
      throw new AnchorStoreError("E_FILE_BINARY", `Imagen no-adjuntable: "${filePath}"`)
    }
    if (content.includes("\0")) {
      throw new AnchorStoreError("E_FILE_BINARY", `Binario (NUL) rechazado: "${filePath}"`)
    }
  }

  function splitLines(content: string): string[] {
    return content.replace(/\r\n/g, "\n").split("\n")
  }

  function differs(a: { content: string }[] | string[], b: string[]): boolean {
    const left = a.map((x) => (typeof x === "string" ? x : x.content))
    return left.length !== b.length || left.some((c, i) => c !== b[i])
  }

  function freshAnchor(): string {
    let anchor = randomAnchor()
    while (used.has(anchor)) anchor = randomAnchor()
    used.add(anchor)
    return anchor
  }

  // Reúso greedy en orden: las no tocadas conservan anchor aunque se muevan.
  function align(old: LineAlloc[], contents: string[]): LineAlloc[] {
    const queues = new Map<string, number[]>()
    old.forEach((l, i) => {
      const q = queues.get(l.content)
      if (q) q.push(i)
      else queues.set(l.content, [i])
    })
    const taken = Array.from({ length: old.length }, () => false)
    let last = -1
    return contents.map((content) => {
      const q = queues.get(content) ?? []
      const pick = q.find((i) => !taken[i] && i > last) ?? q.find((i) => !taken[i])
      if (pick !== undefined) {
        taken[pick] = true
        last = Math.max(last, pick)
        return { anchor: old[pick].anchor, content }
      }
      return { anchor: freshAnchor(), content }
    })
  }

  function toRows(lines: LineAlloc[]): AnchorRow[] {
    return lines.map((l, i) => ({ anchor: l.anchor, line: i + 1, content: l.content }))
  }

  function ingest(
    filePath: string,
    content: string,
    keepShadow: string[] | null,
    dirty: boolean,
  ): ServeResult {
    checkGuards(filePath, content)
    const old = files.get(filePath)?.lines ?? []
    for (const l of old) used.delete(l.anchor)
    totalAnchors -= old.length
    const next = align(old, splitLines(content))
    totalAnchors += next.length
    const warnings: AnchorWarning[] = []
    // Reclamo LRU: evicta otros archivos por seq hasta caber; nunca el actual.
    const reclaimed: string[] = []
    while (totalAnchors > maxAnchors) {
      let victim: string | null = null
      let victimSeq = Infinity
      for (const [path, entry] of files) {
        if (path !== filePath && entry.seq < victimSeq) {
          victim = path
          victimSeq = entry.seq
        }
      }
      if (victim === null) break
      const evicted = files.get(victim)!
      files.delete(victim)
      forget.run(victim)
      for (const l of evicted.lines) used.delete(l.anchor)
      totalAnchors -= evicted.lines.length
      reclaimed.push(victim)
    }
    if (reclaimed.length > 0 || totalAnchors > maxAnchors) {
      warnings.push({
        code: "W_ANCHOR_QUOTA_RECLAIM",
        message:
          reclaimed.length > 0
            ? `Cuota de anchors agotada (${maxAnchors}); reclamados por LRU: ${reclaimed.join(", ")}`
            : `Cuota de anchors agotada (${maxAnchors}) sin candidatos LRU; servido igual`,
      })
    }
    const entry: FileEntry = {
      owner: opts.sessionId,
      lines: next,
      prev: keepShadow,
      seq: ++clock,
      dirty,
    }
    files.set(filePath, entry)
    save(filePath, entry)
    return { rows: toRows(next), warnings }
  }

  function owned(filePath: string): FileEntry {
    const entry = files.get(filePath)
    if (!entry || entry.owner !== opts.sessionId) {
      throw new StaleAnchorError(
        `Sin served-record propio para "${filePath}" en esta sesión`,
        [],
      )
    }
    entry.seq = ++clock
    save(filePath, entry)
    return entry
  }

  function findAnchor(entry: FileEntry, filePath: string, anchor: string): ResolvedAnchor {
    const idx = entry.lines.findIndex((l) => l.anchor === anchor)
    if (idx < 0) {
      throw new StaleAnchorError(
        `Anchor "${anchor}" no servido para "${filePath}"; re-lee para refs frescas`,
        toRows(entry.lines),
      )
    }
    return { line: idx + 1, content: entry.lines[idx].content }
  }

  return {
    serve(filePath: string, content: string): ServeResult {
      const old = files.get(filePath)
      const sameOwner = !!old && old.owner === opts.sessionId
      // Re-serve idéntico no ensucia; absorber un cambio externo marca stale
      // para el undo (aunque luego se relea, el dirty persiste).
      const dirty = sameOwner ? old!.dirty || differs(old!.lines, splitLines(content)) : false
      // La transferencia de ownership no hereda la sombra ajena.
      const prev = sameOwner ? (old!.prev ?? null) : null
      return ingest(filePath, content, prev, dirty)
    },
    commit(
      filePath: string,
      newContent: string,
      commitOpts?: { keepShadow?: boolean },
    ): ServeResult {
      const entry = files.get(filePath)
      if (entry && entry.owner !== opts.sessionId) {
        throw new StaleAnchorError(
          `Sin ownership de "${filePath}" en esta sesión`,
          [],
        )
      }
      // Continuación de batch (#7): preserva la sombra del primer commit.
      const shadow =
        commitOpts?.keepShadow && entry && entry.owner === opts.sessionId
          ? entry.prev
          : entry
            ? entry.lines.map((l) => l.content)
            : null
      return ingest(filePath, newContent, shadow, false)
    },
    resolve(filePath: string, anchor: string): ResolvedAnchor {
      return findAnchor(owned(filePath), filePath, anchor)
    },
    resolveRange(filePath: string, startAnchor: string, endAnchor: string): ResolvedRange {
      const entry = owned(filePath)
      const start = findAnchor(entry, filePath, startAnchor)
      const end = findAnchor(entry, filePath, endAnchor)
      if (start.line > end.line) {
        throw new AnchorStoreError(
          "E_ANCHOR_RANGE",
          `Rango invertido: línea ${start.line} > ${end.line} en "${filePath}"`,
        )
      }
      return { startLine: start.line, endLine: end.line }
    },
    undoShadow(filePath: string): string[] | null {
      const entry = files.get(filePath)
      if (!entry || entry.owner !== opts.sessionId) return null
      return entry.prev ? [...entry.prev] : null
    },
    restoreShadow(filePath: string, diskLines: string[] | null): ServeResult {
      const entry = files.get(filePath)
      if (!entry || entry.owner !== opts.sessionId || !entry.prev) {
        throw new AnchorStoreError(
          "E_UNDO_EMPTY",
          `Sin undo para "${filePath}": no hay cambios propios que deshacer`,
        )
      }
      const current = entry.lines.map((l) => l.content)
      if (diskLines !== null && differs(current, diskLines)) {
        // Realinea para reportar filas frescas (retry accionable); el dirty
        // persiste así que el undo futuro sigue fallando stale.
        const fresh = ingest(filePath, diskLines.join("\n"), entry.prev, true)
        throw new StaleAnchorError(
          `"${filePath}" cambió desde el edit; undo abortado (stale)`,
          fresh.rows,
        )
      }
      if (entry.dirty) {
        throw new StaleAnchorError(
          `"${filePath}" cambió desde el edit; undo abortado (stale)`,
          toRows(entry.lines),
        )
      }
      // diskLines null = archivo borrado: se recrea desde la sombra. Sombra
      // consumida (single-level): el restore no deja undo pendiente.
      return ingest(filePath, entry.prev.join("\n"), null, false)
    },
    close(): void {
      db.close()
    },
  }
}
