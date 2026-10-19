import { constants, mkdirSync, realpathSync } from "node:fs"
import { chmod, copyFile, link, lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import {
  AnchorStoreError,
  StaleAnchorError,
  createAnchorStore,
  errorCode,
  isExcluded,
  type AnchorRow,
  type AnchorStore,
  type ResolvedAnchor,
  type ResolvedRange,
  type ServeResult,
} from "./anchor-store"

import {
  DEFAULT_CONFIG,
  loadHashlineConfig,
  projectKeyFor,
  storePathFor as configStorePathFor,
  type HashlineConfig,
} from "./config"
import type { ToolEditor } from "@opencode/plugin/promise/tool"

// Entrada/salida de los execute: campos validados uno por uno (nunca `any`).
export interface ToolCallInput {
  file?: unknown
  offset?: unknown
  limit?: unknown
  startAnchor?: unknown
  endAnchor?: unknown
  content?: unknown
  match?: unknown
  anchor?: unknown
  position?: unknown
  destFile?: unknown
  destAnchor?: unknown
  pattern?: unknown
}

export interface ToolCallContext {
  sessionID: string
  messageID?: string
  signal?: AbortSignal
}

// Host mínimo que usa el registro: tolera stubs parciales (tests) y el
// Context real del plugin. El editor se tipa con ToolEditor del host.
export interface CoreToolsHost {
  location: { project: { directory: string } }
  options: unknown
  tool: {
    transform: (cb: (editor: ToolEditor) => void) => Promise<unknown>
  }
}

// Defaults del spec (ticket #9): los gobierna la config
// (global < proyecto < opciones); aquí solo quedan como re-export estable.
export const MAX_OUTPUT_LINES = DEFAULT_CONFIG.maxOutputLines
export const MAX_OUTPUT_BYTES = DEFAULT_CONFIG.maxOutputBytes
export const MAX_LINE_CHARS = DEFAULT_CONFIG.maxLineChars

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n")
}

let tmpSeq = 0

// Lost update: el archivo pudo cambiar en disco entre el read de la tool y la
// escritura; expectedRaw es el contenido crudo (BOM/CRLF incluidos) de ese read.
// null = el read lo dio por borrado: el archivo debe seguir ausente.
async function assertUnchanged(
  abs: string,
  expectedRaw: string | null | undefined,
  rel: string,
): Promise<void> {
  if (expectedRaw === undefined) return
  if (expectedRaw === null) {
    try {
      await lstat(abs)
    } catch (err) {
      if (errorCode(err) === "ENOENT") return
      throw err
    }
    throw changedOnCreate(rel)
  }
  let current: string
  try {
    current = await readFile(abs, "utf-8")
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      throw new AnchorStoreError(
        "E_FILE_CHANGED",
        `Cambió en disco desde el read: "${rel}" ya no existe; vuelve a leerlo y reintenta`,
      )
    }
    throw err
  }
  if (current !== expectedRaw) {
    throw new AnchorStoreError(
      "E_FILE_CHANGED",
      `Cambió en disco desde el read: "${rel}"; vuelve a leerlo y reintenta`,
    )
  }
}

// Escritura atómica: temporal en el mismo directorio + rename (mismo filesystem).
// Symlink: escribe el target real (rename reemplazaría el enlace). Modo: el
// inodo nuevo hereda el del destino para no perderlo (p.ej. 0o755).
// La comprobación anti lost-update corre justo antes del rename; el temporal
// ya escrito se borra si falla. expectedRaw null = recrear un borrado: link (o
// copyFile EXCL) sin sobrescribir una creación concurrente.
async function writeAtomic(
  abs: string,
  content: string,
  expectedRaw: string | null | undefined,
  rel: string,
): Promise<void> {
  let target = abs
  try {
    if ((await lstat(abs)).isSymbolicLink()) target = realpathSync(abs)
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err
  }
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${++tmpSeq}.tmp`)
  try {
    await writeFile(tmp, content, "utf-8")
    try {
      await chmod(tmp, (await stat(target)).mode)
    } catch (err) {
      if (errorCode(err) !== "ENOENT") throw err
    }
    // shortcut: la ventana check→rename no es cero sin CAS/lock.
    await assertUnchanged(abs, expectedRaw, rel)
    if (expectedRaw === null) {
      try {
        await link(tmp, target)
      } catch (err) {
        const code = errorCode(err)
        if (code === "EEXIST") throw changedOnCreate(rel)
        if (
          code !== "EPERM" &&
          code !== "EACCES" &&
          code !== "ENOSYS" &&
          code !== "ENOTSUP" &&
          code !== "EXDEV" &&
          code !== "EMLINK"
        ) {
          throw err
        }
        try {
          await copyFile(tmp, target, constants.COPYFILE_EXCL)
        } catch (copyErr) {
          if (errorCode(copyErr) === "EEXIST") throw changedOnCreate(rel)
          throw copyErr
        }
      }
      await rm(tmp, { force: true }).catch(() => {})
    } else {
      await rename(tmp, target)
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

function changedOnCreate(rel: string): AnchorStoreError {
  return new AnchorStoreError(
    "E_FILE_CHANGED",
    `Cambió en disco desde el read: "${rel}" apareció (ya existe); vuelve a leerlo y reintenta`,
  )
}

function resolveInProject(projectDir: string, file: unknown): { abs: string; rel: string } {
  if (typeof file !== "string" || file.length === 0) {
    throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro file requerido (string no vacío)")
  }
  const abs = resolve(projectDir, file)
  const rel = projectKeyFor(projectDir, abs)
  if (rel === null) {
    throw new AnchorStoreError("E_PATH_EXCLUDED", `Path fuera del proyecto: "${file}"`)
  }
  return { abs, rel }
}

// Args de copy/move (#13/#15): mismo contrato validado una sola vez.
function parseTransferArgs(input: ToolCallInput): {
  startAnchor: string
  endAnchor: string | undefined
  destAnchor: string
  position: "before" | "after"
} {
  const { startAnchor, endAnchor, destAnchor, position } = input ?? {}
  if (typeof startAnchor !== "string" || startAnchor.length === 0) {
    throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro startAnchor requerido")
  }
  if (endAnchor !== undefined && (typeof endAnchor !== "string" || endAnchor.length === 0)) {
    throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro endAnchor inválido")
  }
  if (typeof destAnchor !== "string" || destAnchor.length === 0) {
    throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro destAnchor requerido")
  }
  if (position !== "before" && position !== "after") {
    throw new AnchorStoreError(
      "E_INVALID_INPUT",
      `position debe ser "before" o "after": ${JSON.stringify(position)}`,
    )
  }
  return { startAnchor, endAnchor, destAnchor, position }
}

// Rechazo pre-escritura espejo del store: evita dejar disco y store divergentes
// si el commit fallara por guards (el store valida path/size/binario al ingerir).
function checkNewContent(rel: string, newContent: string, maxFileBytes: number): void {
  if (Buffer.byteLength(newContent, "utf-8") > maxFileBytes) {
    throw new AnchorStoreError("E_FILE_OVERSIZE", `Archivo excede ${maxFileBytes} bytes: "${rel}"`)
  }
  if (newContent.includes("\0")) {
    throw new AnchorStoreError("E_FILE_BINARY", `Binario (NUL) rechazado: "${rel}"`)
  }
}

// Batching #7: mismo-mensaje mismo-archivo = una unidad de undo. Clave por
// sesión+mensaje+archivo; solo vive en memoria (los batches no cruzan
// mensajes ni restarts). Tope anti-crecimiento.
interface BatchState {
  touched: Set<string>
  commits: number
  aborted: string | null
}

function formatRow(row: AnchorRow, maxLineChars: number): string {
  if (row.content.length > maxLineChars) {
    return `${row.anchor}│${row.content.slice(0, maxLineChars)} ⟨+${row.content.length - maxLineChars} chars⟩`
  }
  return `${row.anchor}│${row.content}`
}

function formatWarnings(warnings: { code: string; message: string }[]): string[] {
  return warnings.map((w) => `${w.code}: ${w.message}`)
}

// El host solo muestra el mensaje del error al modelo (e2e #10): las filas
// viajan en el texto para retry sin re-read. Preserva clase y rows para
// los consumidores programáticos.
function withCurrentRows(err: StaleAnchorError, maxLineChars: number): StaleAnchorError {
  if (!err.rows || err.rows.length === 0) return err
  return new StaleAnchorError(
    `${err.message.replace(/^\[[A-Z_]{2,}\] /, "")}\nCurrent rows:\n${err.rows.map((r) => formatRow(r, maxLineChars)).join("\n")}`,
    err.rows,
  )
}

interface Page {
  text: string
  metadata: Record<string, unknown>
}

// Ventana paginada con doble tope (líneas + bytes) y hint de continuación.
function renderPage(
  rows: AnchorRow[],
  startLine: number,
  limit: number,
  warnings: { code: string; message: string }[],
  cfg: HashlineConfig,
): Page {
  const window = rows.slice(startLine - 1, startLine - 1 + limit)
  const lines: string[] = []
  let bytes = 0
  let shown = 0
  for (const row of window) {
    const text = formatRow(row, cfg.maxLineChars)
    const size = Buffer.byteLength(text + "\n", "utf-8")
    if (bytes + size > cfg.maxOutputBytes && shown > 0) break
    lines.push(text)
    bytes += size
    shown++
  }
  const endLine = startLine + shown - 1
  const remaining = rows.length - (startLine - 1) - shown
  const hasMore = remaining > 0
  if (hasMore) {
    const next = rows[startLine - 1 + shown]
    lines.push(
      `… +${remaining} more lines (total ${rows.length}). Re-read from anchor ${next.anchor} or line ${next.line}.`,
    )
  } else if (shown === 0) {
    lines.push(`(${rows.length} lines total.)`)
  }
  lines.push(...formatWarnings(warnings))
  return {
    text: lines.join("\n"),
    metadata: {
      totalLines: rows.length,
      startLine,
      endLine: shown === 0 ? startLine - 1 : endLine,
      hasMore,
      ...(hasMore ? { nextAnchor: rows[startLine - 1 + shown].anchor } : {}),
      warnings: warnings.map((w) => w.code),
    },
  }
}

function parseOffset(offset: unknown, resolveAnchor: (anchor: string) => number): number {
  if (offset === undefined) return 1
  if (typeof offset === "number") {
    if (!Number.isInteger(offset) || offset < 1) {
      throw new AnchorStoreError("E_INVALID_INPUT", `offset inválido: ${JSON.stringify(offset)}`)
    }
    return offset
  }
  if (typeof offset === "string") {
    if (/^\d+$/.test(offset)) {
      const n = Number(offset)
      if (n < 1) throw new AnchorStoreError("E_INVALID_INPUT", `offset inválido: "${offset}"`)
      return n
    }
    return resolveAnchor(offset)
  }
  throw new AnchorStoreError("E_INVALID_INPUT", `offset inválido: ${JSON.stringify(offset)}`)
}

function parseLimit(limit: unknown, maxOutputLines: number): number {
  if (limit === undefined) return maxOutputLines
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new AnchorStoreError("E_INVALID_INPUT", `limit inválido: ${JSON.stringify(limit)}`)
  }
  return Math.min(limit, maxOutputLines)
}

interface DiskFile {
  text: string
  eol: "\n" | "\r\n"
  bom: boolean
  /** Contenido exacto de readFile, antes de quitar BOM o normalizar CRLF. */
  raw: string
}

async function readDisk(abs: string, rel: string): Promise<DiskFile> {
  let raw: string
  try {
    raw = await readFile(abs, "utf-8")
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      throw new AnchorStoreError("E_FILE_NOT_FOUND", `No existe: "${rel}"`)
    }
    if (errorCode(err) === "EISDIR") {
      throw new AnchorStoreError("E_INVALID_INPUT", `No es un archivo: "${rel}"`)
    }
    throw err
  }
  const bom = raw.startsWith("\uFEFF")
  const body = bom ? raw.slice(1) : raw
  const crlf = body.match(/\r\n/g)?.length ?? 0
  const lf = (body.match(/\n/g)?.length ?? 0) - crlf
  return { text: body.replace(/\r\n/g, "\n"), eol: crlf > lf ? "\r\n" : "\n", bom, raw }
}

function serialize(lines: string[], meta: { eol: "\n" | "\r\n"; bom: boolean }): string {
  return `${meta.bom ? "\uFEFF" : ""}${lines.join(meta.eol)}`
}

export interface CoreToolsDeps {
  /** Config ya resuelta por el entry (precedencia global < proyecto < opciones). */
  config?: HashlineConfig
  /** Store compartido por sesión (unificación admisión/tools del ticket #9). */
  storeFor?: (sessionID: string) => AnchorStore
}

export async function registerCoreTools(ctx: CoreToolsHost, deps?: CoreToolsDeps): Promise<() => void> {
  const projectDir: string = ctx.location.project.directory
  const cfg = deps?.config ?? (await loadHashlineConfig({ projectDir, options: ctx.options }))
  const stores = new Map<string, AnchorStore>()
  const batches = new Map<string, BatchState>()

  function batchFor(sessionID: unknown, messageID: unknown, rel: string): BatchState | null {
    if (typeof sessionID !== "string" || typeof messageID !== "string") return null
    const key = `${sessionID}\n${messageID}\n${rel}`
    let batch = batches.get(key)
    if (!batch) {
      if (batches.size > 200) batches.delete(batches.keys().next().value!)
      batch = { touched: new Set(), commits: 0, aborted: null }
      batches.set(key, batch)
    }
    return batch
  }

  function assertBatchOpen(batch: BatchState | null, rel: string): void {
    if (batch?.aborted) {
      throw new AnchorStoreError(
        "E_BATCH_ABORTED",
        `Batch para "${rel}" abortado tras ${batch.aborted}; reintenta en un mensaje nuevo`,
      )
    }
  }

  // Fallo de archivo/commit: aborta el batch con marca explícita. Los errores
  // de validación/resolución (stale, rango, input) NO pasan por aquí: fallan solos.
  async function tracked<T>(batch: BatchState | null, rel: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (batch) batch.aborted = errorCode(err) ?? "E_FILE_WRITE"
      if (err instanceof AnchorStoreError) {
        err.message += ` (H_BATCH_ABORTED: batch para "${rel}" abortado)`
        throw err
      }
      throw new AnchorStoreError(
        "E_FILE_WRITE",
        `No se pudo escribir "${rel}": ${err instanceof Error ? err.message : String(err)} (H_BATCH_ABORTED: batch para "${rel}" abortado)`,
      )
    }
  }

  function assertDisjoint(
    batch: BatchState | null,
    rel: string,
    anchors: string[],
    where: string,
  ): void {
    if (!batch) return
    const hit = anchors.find((a) => batch.touched.has(a))
    if (hit) {
      throw new AnchorStoreError(
        "E_BATCH_OVERLAP",
        `Batch solapado en "${rel}": ${where} toca "${hit}", ya editado en este mensaje; usa rangos disjuntos o un mensaje nuevo`,
      )
    }
  }

  function ownStoreFor(sessionID: string): AnchorStore {
    const cached = stores.get(sessionID)
    if (cached) return cached
    const storePath = configStorePathFor(projectDir, sessionID, cfg.storeDir)
    mkdirSync(dirname(storePath), { recursive: true })
    const store = createAnchorStore({
      sessionId: sessionID,
      storePath,
      maxFileBytes: cfg.maxFileBytes,
      maxAnchors: cfg.maxAnchors,
      excludes: cfg.excludes,
    })
    stores.set(sessionID, store)
    return store
  }

  const storeFor = deps?.storeFor ?? ownStoreFor

  async function readExecute(rawInput: unknown, context: ToolCallContext) {
    // El host valida contra el JSON schema; aquí se valida campo por campo.
    const input: ToolCallInput = (rawInput ?? {}) as ToolCallInput
    const { abs, rel } = resolveInProject(projectDir, input?.file)
    const disk = await readDisk(abs, rel)
    const store = storeFor(context.sessionID)
    const served = store.serve(rel, disk.text)
    let startLine: number
    try {
      startLine = parseOffset(input?.offset, (anchor) => store.resolve(rel, anchor).line)
    } catch (err) {
      if (err instanceof StaleAnchorError) throw withCurrentRows(err, cfg.maxLineChars)
      throw err
    }
    const limit = parseLimit(input?.limit, cfg.maxOutputLines)
    const page = renderPage(served.rows, startLine, limit, served.warnings, cfg)
    return { content: page.text, metadata: page.metadata }
  }

  async function replaceExecute(rawInput: unknown, context: ToolCallContext) {
    const input: ToolCallInput = (rawInput ?? {}) as ToolCallInput
    const { abs, rel } = resolveInProject(projectDir, input?.file)
    const { startAnchor, endAnchor, content } = input ?? {}
    if (typeof startAnchor !== "string" || startAnchor.length === 0) {
      throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro startAnchor requerido")
    }
    if (endAnchor !== undefined && (typeof endAnchor !== "string" || endAnchor.length === 0)) {
      throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro endAnchor inválido")
    }
    if (typeof content !== "string") {
      throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro content requerido (string)")
    }
    const batch = batchFor(context?.sessionID, context?.messageID, rel)
    assertBatchOpen(batch, rel)
    const disk = await tracked(batch, rel, () => readDisk(abs, rel))
    const store = storeFor(context.sessionID)
    const oldRows = await tracked(batch, rel, async () => store.serve(rel, disk.text).rows)
    // Pre-commit: los mismos anchors originales reintentados son solape,
    // no stale (el resolve posterior fallaría con E_ANCHOR_STALE).
    assertDisjoint(batch, rel, [startAnchor, endAnchor ?? startAnchor], `rango ${startAnchor}-${endAnchor ?? startAnchor}`)
    let range
    try {
      range = store.resolveRange(rel, startAnchor, endAnchor ?? startAnchor)
    } catch (err) {
      if (err instanceof StaleAnchorError) throw withCurrentRows(err, cfg.maxLineChars)
      throw err
    }
    // Post-resolve: el solape vía re-lectura usa anchors nuevos del batch.
    const preAnchors = oldRows.slice(range.startLine - 1, range.endLine).map((r) => r.anchor)
    assertDisjoint(
      batch,
      rel,
      preAnchors,
      `rango ${startAnchor}-${endAnchor ?? startAnchor}`,
    )
    const diskLines = splitLines(disk.text)
    const newLines = splitLines(content)
    const oldSlice = diskLines.slice(range.startLine - 1, range.endLine)
    if (oldSlice.length === newLines.length && oldSlice.every((l, i) => l === newLines[i])) {
      return {
        content: `H_NOOP: no changes to ${rel} (range already matches).`,
        metadata: { changed: false, file: rel, startLine: range.startLine, endLine: range.endLine },
      }
    }
    const newContent = [
      ...diskLines.slice(0, range.startLine - 1),
      ...newLines,
      ...diskLines.slice(range.endLine),
    ].join("\n")
    const finalContent = serialize(splitLines(newContent), disk)
    await tracked(batch, rel, async () => {
      checkNewContent(rel, finalContent, cfg.maxFileBytes)
    })
    await tracked(batch, rel, () => writeAtomic(abs, finalContent, disk.raw, rel))
    const committed = await tracked(batch, rel, () =>
      // Continuación de batch: un solo undo por mensaje (sombra del primero).
      Promise.resolve(
        batch && batch.commits > 0
          ? store.commit(rel, newContent, { keepShadow: true })
          : store.commit(rel, newContent),
      ),
    )
    if (batch) {
      batch.commits++
      // Touched = rangos pre-commit (líneas originales) + filas nuevas
      // post-commit: el reintento con anchors viejos y el solape vía
      // re-lectura con anchors nuevos dan E_BATCH_OVERLAP.
      for (const a of preAnchors) batch.touched.add(a)
      for (const r of committed.rows.slice(
        range.startLine - 1,
        range.startLine - 1 + newLines.length,
      )) {
        batch.touched.add(r.anchor)
      }
    }
    const removed = oldRows.slice(range.startLine - 1, range.endLine).map((r) => `- ${formatRow(r, cfg.maxLineChars)}`)
    const added = committed.rows
      .slice(range.startLine - 1, range.startLine - 1 + newLines.length)
      .map((r) => `+ ${formatRow(r, cfg.maxLineChars)}`)
    const lines = [
      `replace ${rel} lines ${range.startLine}-${range.endLine} (anchors ${startAnchor}-${endAnchor ?? startAnchor}):`,
      ...removed,
      ...added,
      `${committed.rows.length} lines total.`,
      ...formatWarnings(committed.warnings),
    ]
    return {
      content: lines.join("\n"),
      metadata: {
        changed: true,
        file: rel,
        startLine: range.startLine,
        endLine: range.startLine + newLines.length - 1,
        totalLines: committed.rows.length,
      },
    }
  }

  // replace_match (#12): sustitución literal case-sensitive de un Match
  // servido. Reutiliza tracked/disjoint/commit del Batch como `replace`:
  // cero o múltiples ocurrencias → E_ANCHOR_MATCH sin escribir (falla
  // sola, sin abortar el batch).
  async function replaceMatchExecute(rawInput: unknown, context: ToolCallContext) {
    const input: ToolCallInput = (rawInput ?? {}) as ToolCallInput
    const { abs, rel } = resolveInProject(projectDir, input?.file)
    const { match, content } = input ?? {}
    if (typeof match !== "string" || match.length === 0) {
      throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro match requerido (string no vacío)")
    }
    if (typeof content !== "string") {
      throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro content requerido (string)")
    }
    const batch = batchFor(context?.sessionID, context?.messageID, rel)
    assertBatchOpen(batch, rel)
    const disk = await tracked(batch, rel, () => readDisk(abs, rel))
    const store = storeFor(context.sessionID)
    const oldRows = await tracked(batch, rel, async () => store.serve(rel, disk.text).rows)
    // Conteo literal case-sensitive sobre lo servido (paso +1: los
    // solapes también cuentan como ambigüedad).
    let count = 0
    let at = disk.text.indexOf(match)
    while (at >= 0) {
      count++
      at = disk.text.indexOf(match, at + 1)
    }
    if (count !== 1) {
      throw new AnchorStoreError(
        "E_ANCHOR_MATCH",
        count === 0
          ? `Match no servido en "${rel}": ${JSON.stringify(match.slice(0, 120))} (0 ocurrencias; sin escritura)`
          : `Match ambiguo en "${rel}": ${JSON.stringify(match.slice(0, 120))} (${count} ocurrencias; sin escritura)`,
      )
    }
    const idx = disk.text.indexOf(match)
    const startLine = disk.text.slice(0, idx).split("\n").length
    const endLine = disk.text.slice(0, idx + match.length).split("\n").length
    const preAnchors = oldRows.slice(startLine - 1, endLine).map((r) => r.anchor)
    assertDisjoint(batch, rel, preAnchors, `match ${JSON.stringify(match.slice(0, 60))}`)
    const newContent = disk.text.slice(0, idx) + content + disk.text.slice(idx + match.length)
    if (newContent === disk.text) {
      return {
        content: `H_NOOP: no changes to ${rel} (match already matches).`,
        metadata: { changed: false, file: rel, startLine, endLine },
      }
    }
    const finalContent = serialize(splitLines(newContent), disk)
    await tracked(batch, rel, async () => {
      checkNewContent(rel, finalContent, cfg.maxFileBytes)
    })
    await tracked(batch, rel, () => writeAtomic(abs, finalContent, disk.raw, rel))
    const committed = await tracked(batch, rel, () =>
      // Continuación de batch: un solo undo por mensaje (sombra del primero).
      Promise.resolve(
        batch && batch.commits > 0
          ? store.commit(rel, newContent, { keepShadow: true })
          : store.commit(rel, newContent),
      ),
    )
    // Rango nuevo = viejo ± delta de líneas: el reintento vía re-lectura
    // sobre lo creado da E_BATCH_OVERLAP.
    const newEndLine = endLine + (committed.rows.length - oldRows.length)
    if (batch) {
      batch.commits++
      // Touched = líneas originales + filas nuevas post-commit.
      for (const a of preAnchors) batch.touched.add(a)
      for (const r of committed.rows.slice(startLine - 1, newEndLine)) batch.touched.add(r.anchor)
    }
    const removed = oldRows.slice(startLine - 1, endLine).map((r) => `- ${formatRow(r, cfg.maxLineChars)}`)
    const added = committed.rows
      .slice(startLine - 1, newEndLine)
      .map((r) => `+ ${formatRow(r, cfg.maxLineChars)}`)
    const lines = [
      `replace_match ${rel} lines ${startLine}-${endLine} (match ${JSON.stringify(match.slice(0, 60))}):`,
      ...removed,
      ...added,
      `${committed.rows.length} lines total.`,
      ...formatWarnings(committed.warnings),
    ]
    return {
      content: lines.join("\n"),
      metadata: {
        changed: true,
        file: rel,
        startLine,
        endLine: newEndLine,
        totalLines: committed.rows.length,
      },
    }
  }

  async function insertExecute(rawInput: unknown, context: ToolCallContext) {
    const input: ToolCallInput = (rawInput ?? {}) as ToolCallInput
    const { abs, rel } = resolveInProject(projectDir, input?.file)
    const { anchor, position, content } = input ?? {}
    if (typeof anchor !== "string" || anchor.length === 0) {
      throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro anchor requerido")
    }
    if (position !== "before" && position !== "after") {
      throw new AnchorStoreError(
        "E_INVALID_INPUT",
        `position debe ser "before" o "after": ${JSON.stringify(position)}`,
      )
    }
    if (typeof content !== "string") {
      throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro content requerido (string)")
    }
    const batch = batchFor(context?.sessionID, context?.messageID, rel)
    assertBatchOpen(batch, rel)
    const disk = await tracked(batch, rel, () => readDisk(abs, rel))
    const store = storeFor(context.sessionID)
    await tracked(batch, rel, async () => {
      store.serve(rel, disk.text)
    })
    let resolved
    // Pre-commit: reinsertar sobre el mismo anchor del batch es solape,
    // no un segundo punto válido (el resolve posterior pasaría).
    assertDisjoint(batch, rel, [anchor], `insert en "${anchor}"`)
    try {
      resolved = store.resolve(rel, anchor)
    } catch (err) {
      if (err instanceof StaleAnchorError) throw withCurrentRows(err, cfg.maxLineChars)
      throw err
    }
    const diskLines = splitLines(disk.text)
    const newLines = splitLines(content)
    const idx = position === "before" ? resolved.line - 1 : resolved.line
    const newContent = [...diskLines.slice(0, idx), ...newLines, ...diskLines.slice(idx)].join("\n")
    const finalContent = serialize(splitLines(newContent), disk)
    await tracked(batch, rel, async () => {
      checkNewContent(rel, finalContent, cfg.maxFileBytes)
    })
    await tracked(batch, rel, () => writeAtomic(abs, finalContent, disk.raw, rel))
    const committed = await tracked(batch, rel, () =>
      Promise.resolve(
        batch && batch.commits > 0
          ? store.commit(rel, newContent, { keepShadow: true })
          : store.commit(rel, newContent),
      ),
    )
    if (batch) {
      batch.commits++
      // Punto pre-commit + filas nuevas: repetir el anchor o tocar lo
      // creado da E_BATCH_OVERLAP.
      batch.touched.add(anchor)
      for (const r of committed.rows.slice(idx, idx + newLines.length)) batch.touched.add(r.anchor)
    }
    const added = committed.rows
      .slice(idx, idx + newLines.length)
      .map((r) => `+ ${formatRow(r, cfg.maxLineChars)}`)
    const lines = [
      `insert ${rel} ${position} anchor ${anchor} (line ${resolved.line}):`,
      ...added,
      `${committed.rows.length} lines total.`,
      ...formatWarnings(committed.warnings),
    ]
    return {
      content: lines.join("\n"),
      metadata: { changed: true, file: rel, line: resolved.line, totalLines: committed.rows.length },
    }
  }

  // Lado origen de copy/move: serve + disjoint pre-commit + resolveRange +
  // disjoint vía re-lectura. `label` distingue el mensaje ("copy"/"move").
  async function resolveTransferSource(
    store: AnchorStore,
    batchSrc: BatchState | null,
    srcRel: string,
    srcDisk: DiskFile,
    startAnchor: string,
    endAnchor: string | undefined,
    label: string,
  ): Promise<{ srcRange: ResolvedRange; preAnchors: string[] }> {
    const srcRows = await tracked(batchSrc, srcRel, async () => store.serve(srcRel, srcDisk.text).rows)
    const where = `${label} origen ${startAnchor}-${endAnchor ?? startAnchor}`
    // Pre-commit: re-copiar el mismo rango del batch es solape, no stale.
    assertDisjoint(batchSrc, srcRel, [startAnchor, endAnchor ?? startAnchor], where)
    let srcRange: ResolvedRange
    try {
      srcRange = store.resolveRange(srcRel, startAnchor, endAnchor ?? startAnchor)
    } catch (err) {
      if (err instanceof StaleAnchorError) throw withCurrentRows(err, cfg.maxLineChars)
      throw err
    }
    const preAnchors = srcRows.slice(srcRange.startLine - 1, srcRange.endLine).map((r) => r.anchor)
    assertDisjoint(batchSrc, srcRel, preAnchors, where)
    return { srcRange, preAnchors }
  }

  // Camino de commit a destino compartido por copy (#13) y move (#15):
  // serve + resolve del punto, foto, cómputo, pre-escritura, write y commit.
  // Sin marcado de batch: cada llamador marca su nivel de undo tras el
  // commit (move lo hace antes de vaciar el origen, para no perderlo si falla).
  async function commitDestCopy(
    store: AnchorStore,
    batchDst: BatchState | null,
    dstAbs: string,
    dstRel: string,
    destAnchor: string,
    position: "before" | "after",
    srcLines: string[],
  ): Promise<{ committed: ServeResult; dstResolved: ResolvedAnchor; idx: number }> {
    const dstDisk = await tracked(batchDst, dstRel, () => readDisk(dstAbs, dstRel))
    // US7: el destino debe estar ya servido en la sesión; servirlo aquí
    // auto-verificaría contexto no verificado. Falla stale sin servir ni
    // dejar efecto lateral (cubre a copy y a move: mismo camino).
    if (store.peek(dstRel) === null) {
      throw new AnchorStoreError(
        "E_ANCHOR_STALE",
        `Destino no servido en esta sesión: "${dstRel}"; usa read para servirlo antes de copiar`,
      )
    }
    await tracked(batchDst, dstRel, async () => {
      store.serve(dstRel, dstDisk.text)
    })
    // Pre-commit: re-copiar sobre el mismo punto de destino es solape.
    assertDisjoint(batchDst, dstRel, [destAnchor], `destino en "${destAnchor}"`)
    let dstResolved: ResolvedAnchor
    try {
      dstResolved = store.resolve(dstRel, destAnchor)
    } catch (err) {
      if (err instanceof StaleAnchorError) throw withCurrentRows(err, cfg.maxLineChars)
      throw err
    }
    const dstLines = splitLines(dstDisk.text)
    const idx = position === "before" ? dstResolved.line - 1 : dstResolved.line
    const newContent = [...dstLines.slice(0, idx), ...srcLines, ...dstLines.slice(idx)].join("\n")
    const finalContent = serialize(splitLines(newContent), dstDisk)
    await tracked(batchDst, dstRel, async () => {
      checkNewContent(dstRel, finalContent, cfg.maxFileBytes)
    })
    await tracked(batchDst, dstRel, () => writeAtomic(dstAbs, finalContent, dstDisk.raw, dstRel))
    const committed = await tracked(batchDst, dstRel, () =>
      Promise.resolve(
        batchDst && batchDst.commits > 0
          ? store.commit(dstRel, newContent, { keepShadow: true })
          : store.commit(dstRel, newContent),
      ),
    )
    return { committed, dstResolved, idx }
  }

  // Copy #13: replica líneas servidas del origen en un destino ya servido
  // de la misma sesión. El origen solo se trackea en su batch (sin commit:
  // su undo queda vacío); el destino commitea como un insert (keepShadow en
  // continuación). Sin herencia: las copiadas realinean anchors del destino.
  async function copyExecute(rawInput: unknown, context: ToolCallContext) {
    const input: ToolCallInput = (rawInput ?? {}) as ToolCallInput
    const { abs: srcAbs, rel: srcRel } = resolveInProject(projectDir, input?.file)
    const { abs: dstAbs, rel: dstRel } = resolveInProject(projectDir, input?.destFile)
    const { startAnchor, endAnchor, destAnchor, position } = parseTransferArgs(input)
    // Un batch por lado (misma clave si origen y destino coinciden): el undo
    // de cada archivo sigue funcionando por separado.
    const batchSrc = batchFor(context?.sessionID, context?.messageID, srcRel)
    const batchDst = batchFor(context?.sessionID, context?.messageID, dstRel)
    assertBatchOpen(batchSrc, srcRel)
    if (batchDst !== batchSrc) assertBatchOpen(batchDst, dstRel)
    const srcDisk = await tracked(batchSrc, srcRel, () => readDisk(srcAbs, srcRel))
    const store = storeFor(context.sessionID)
    const { srcRange, preAnchors } = await resolveTransferSource(
      store,
      batchSrc,
      srcRel,
      srcDisk,
      startAnchor,
      endAnchor,
      "copy",
    )
    // Foto pre-escritura: el mismo-archivo copia duplicando, nunca mezcla.
    const srcLines = splitLines(srcDisk.text).slice(srcRange.startLine - 1, srcRange.endLine)
    // Commit a destino por el camino compartido con move (#15).
    const { committed, dstResolved, idx } = await commitDestCopy(
      store,
      batchDst,
      dstAbs,
      dstRel,
      destAnchor,
      position,
      srcLines,
    )
    // Marcado al final: move (#15) vacía el origen entre el commit de destino
    // y este marcado sin auto-solaparse.
    if (batchDst) {
      batchDst.commits++
      batchDst.touched.add(destAnchor)
      for (const r of committed.rows.slice(idx, idx + srcLines.length)) batchDst.touched.add(r.anchor)
    }
    if (batchSrc) {
      for (const a of preAnchors) batchSrc.touched.add(a)
    }
    const added = committed.rows
      .slice(idx, idx + srcLines.length)
      .map((r) => `+ ${formatRow(r, cfg.maxLineChars)}`)
    const lines = [
      `copy ${srcRel} lines ${srcRange.startLine}-${srcRange.endLine} (anchors ${startAnchor}-${endAnchor ?? startAnchor}) ${position} ${dstRel} anchor ${destAnchor} (line ${dstResolved.line}):`,
      ...added,
      `${committed.rows.length} lines total.`,
      ...formatWarnings(committed.warnings),
    ]
    return {
      content: lines.join("\n"),
      metadata: {
        changed: true,
        file: dstRel,
        sourceFile: srcRel,
        startLine: srcRange.startLine,
        endLine: srcRange.endLine,
        line: dstResolved.line,
        totalLines: committed.rows.length,
      },
    }
  }

  // Move #15: destino-primero — el destino commitea por el camino de copy y
  // solo entonces se vacía el origen en el mismo mensaje. Fallo en destino
  // → origen intacto. Un batch y un undo por archivo: sin undo atómico
  // cross-file (decisión de spec, no deuda).
  async function moveExecute(rawInput: unknown, context: ToolCallContext) {
    const input: ToolCallInput = (rawInput ?? {}) as ToolCallInput
    const { abs: srcAbs, rel: srcRel } = resolveInProject(projectDir, input?.file)
    const { abs: dstAbs, rel: dstRel } = resolveInProject(projectDir, input?.destFile)
    const { startAnchor, endAnchor, destAnchor, position } = parseTransferArgs(input)
    const batchSrc = batchFor(context?.sessionID, context?.messageID, srcRel)
    const batchDst = batchFor(context?.sessionID, context?.messageID, dstRel)
    assertBatchOpen(batchSrc, srcRel)
    if (batchDst !== batchSrc) assertBatchOpen(batchDst, dstRel)
    const srcDisk = await tracked(batchSrc, srcRel, () => readDisk(srcAbs, srcRel))
    const store = storeFor(context.sessionID)
    const { srcRange, preAnchors } = await resolveTransferSource(
      store,
      batchSrc,
      srcRel,
      srcDisk,
      startAnchor,
      endAnchor,
      "move",
    )
    const srcLines = splitLines(srcDisk.text).slice(srcRange.startLine - 1, srcRange.endLine)

    if (srcRel === dstRel) {
      // Mismo archivo: quitar-y-poner en un solo commit (un batch, un undo).
      // En dos pasos corrompería: tras insertar la copia los anchors viejos
      // realinean sobre ambas y el vaciado se comería lo recién insertado.
      assertDisjoint(batchSrc, srcRel, [destAnchor], `move destino en "${destAnchor}"`)
      let dstResolved: ResolvedAnchor
      try {
        dstResolved = store.resolve(srcRel, destAnchor)
      } catch (err) {
        if (err instanceof StaleAnchorError) throw withCurrentRows(err, cfg.maxLineChars)
        throw err
      }
      const all = splitLines(srcDisk.text)
      const n = srcLines.length
      const idx = position === "before" ? dstResolved.line - 1 : dstResolved.line
      // Punto de inserción tras quitar el rango: antes, después o dentro
      // (dentro del rango = identidad).
      const at =
        idx <= srcRange.startLine - 1
          ? idx
          : idx >= srcRange.endLine
            ? idx - n
            : srcRange.startLine - 1
      const rest = [...all.slice(0, srcRange.startLine - 1), ...all.slice(srcRange.endLine)]
      const newContent = [...rest.slice(0, at), ...srcLines, ...rest.slice(at)].join("\n")
      if (newContent === srcDisk.text) {
        return {
          content: `H_NOOP: no changes to ${srcRel} (move already in place).`,
          metadata: {
            changed: false,
            file: srcRel,
            startLine: srcRange.startLine,
            endLine: srcRange.endLine,
          },
        }
      }
      const finalContent = serialize(splitLines(newContent), srcDisk)
      await tracked(batchSrc, srcRel, async () => {
        checkNewContent(srcRel, finalContent, cfg.maxFileBytes)
      })
      await tracked(batchSrc, srcRel, () => writeAtomic(srcAbs, finalContent, srcDisk.raw, srcRel))
      const committed = await tracked(batchSrc, srcRel, () =>
        Promise.resolve(
          batchSrc && batchSrc.commits > 0
            ? store.commit(srcRel, newContent, { keepShadow: true })
            : store.commit(srcRel, newContent),
        ),
      )
      if (batchSrc) {
        batchSrc.commits++
        for (const a of preAnchors) batchSrc.touched.add(a)
        batchSrc.touched.add(destAnchor)
        for (const r of committed.rows.slice(at, at + n)) batchSrc.touched.add(r.anchor)
      }
      const added = committed.rows.slice(at, at + n).map((r) => `+ ${formatRow(r, cfg.maxLineChars)}`)
      const lines = [
        `move ${srcRel} lines ${srcRange.startLine}-${srcRange.endLine} (anchors ${startAnchor}-${endAnchor ?? startAnchor}) ${position} anchor ${destAnchor} (line ${dstResolved.line}):`,
        ...added,
        `${committed.rows.length} lines total.`,
        ...formatWarnings(committed.warnings),
      ]
      return {
        content: lines.join("\n"),
        metadata: {
          changed: true,
          file: srcRel,
          sourceFile: srcRel,
          startLine: srcRange.startLine,
          endLine: srcRange.endLine,
          line: dstResolved.line,
          totalLines: committed.rows.length,
        },
      }
    }

    // Dos archivos: el destino commitea PRIMERO por el camino de copy; el
    // origen se vacía solo entonces, en el mismo mensaje. El pre-check detecta
    // cambios del origen antes de tocar el destino; si cambia entre el commit
    // del destino y el vaciado el resultado es duplicado (destino escrito,
    // origen intacto), nunca pérdida.
    await assertUnchanged(srcAbs, srcDisk.raw, srcRel)
    const dest = await commitDestCopy(store, batchDst, dstAbs, dstRel, destAnchor, position, srcLines)
    const { committed, dstResolved, idx } = dest
    // Nivel de undo del destino antes de vaciar el origen: si el vaciado
    // falla, el siguiente edit del destino sigue conservando la sombra.
    if (batchDst) {
      batchDst.commits++
      batchDst.touched.add(destAnchor)
      for (const r of committed.rows.slice(idx, idx + srcLines.length))
        batchDst.touched.add(r.anchor)
    }
    // Vaciado del origen ANTES del marcado de preAnchors (aviso #13): toca el
    // mismo rango a propósito y bypassea disjoint (ya verificado arriba).
    // Subconjunto del contenido: sin checkNewContent (solo encoge).
    const emptied = [
      ...splitLines(srcDisk.text).slice(0, srcRange.startLine - 1),
      ...splitLines(srcDisk.text).slice(srcRange.endLine),
    ].join("\n")
    const finalEmptied = serialize(splitLines(emptied), srcDisk)
    await tracked(batchSrc, srcRel, () => writeAtomic(srcAbs, finalEmptied, srcDisk.raw, srcRel))
    const srcCommitted = await tracked(batchSrc, srcRel, () =>
      Promise.resolve(
        batchSrc && batchSrc.commits > 0
          ? store.commit(srcRel, emptied, { keepShadow: true })
          : store.commit(srcRel, emptied),
      ),
    )
    if (batchSrc) {
      batchSrc.commits++
      for (const a of preAnchors) batchSrc.touched.add(a)
    }
    const added = committed.rows
      .slice(idx, idx + srcLines.length)
      .map((r) => `+ ${formatRow(r, cfg.maxLineChars)}`)
    const lines = [
      `move ${srcRel} lines ${srcRange.startLine}-${srcRange.endLine} (anchors ${startAnchor}-${endAnchor ?? startAnchor}) ${position} ${dstRel} anchor ${destAnchor} (line ${dstResolved.line}):`,
      ...added,
      `${dstRel}: ${committed.rows.length} lines total; ${srcRel}: ${srcCommitted.rows.length} lines total.`,
      ...formatWarnings(committed.warnings),
      ...formatWarnings(srcCommitted.warnings),
    ]
    return {
      content: lines.join("\n"),
      metadata: {
        changed: true,
        file: dstRel,
        sourceFile: srcRel,
        startLine: srcRange.startLine,
        endLine: srcRange.endLine,
        line: dstResolved.line,
        totalLines: committed.rows.length,
        sourceTotalLines: srcCommitted.rows.length,
      },
    }
  }

  async function undoExecute(rawInput: unknown, context: ToolCallContext) {
    const input: ToolCallInput = (rawInput ?? {}) as ToolCallInput
    const { abs, rel } = resolveInProject(projectDir, input?.file)
    let diskLines: string[] | null
    let diskRaw: string | undefined
    let diskMeta: { eol: "\n" | "\r\n"; bom: boolean } = { eol: "\n", bom: false }
    try {
      const disk = await readDisk(abs, rel)
      diskLines = splitLines(disk.text)
      diskMeta = disk
      diskRaw = disk.raw
    } catch (err) {
      // Archivo borrado tras el edit: se recrea desde la sombra.
      if (err instanceof AnchorStoreError && err.code === "E_FILE_NOT_FOUND") diskLines = null
      else throw err
    }
    const store = storeFor(context.sessionID)
    const beforeRestore = store.peek(rel)
    const restored = store.restoreShadow(rel, diskLines)
    const restoredLines = restored.rows.map((r) => r.content)
    try {
      // shortcut: al recrear se pierde el EOL/BOM original (la sombra solo guarda contenido).
      await writeAtomic(abs, serialize(restoredLines, diskMeta), diskLines === null ? null : diskRaw, rel)
    } catch (err) {
      // restoreShadow ya consumió la sombra; si la escritura falla, commit
      // devuelve el estado pre-undo y la sombra disponible.
      const rollbackContent =
        diskLines !== null ? diskLines.join("\n") : beforeRestore?.map((r) => r.content).join("\n")
      if (rollbackContent !== undefined) {
        try {
          store.commit(rel, rollbackContent)
        } catch {}
      }
      throw err
    }
    // El undo cierra los batches abiertos de este archivo: el próximo edit
    // abre un nivel de undo fresco.
    const sessionID = context?.sessionID
    if (typeof sessionID === "string") {
      for (const key of batches.keys()) {
        if (key.startsWith(`${sessionID}\n`) && key.endsWith(`\n${rel}`)) batches.delete(key)
      }
    }
    const lines = [
      `undo ${rel}: restored ${restored.rows.length} lines.`,
      ...restored.rows.map((r) => `+ ${formatRow(r, cfg.maxLineChars)}`),
      `${restored.rows.length} lines total.`,
      ...formatWarnings(restored.warnings),
    ]
    return {
      content: lines.join("\n"),
      metadata: { restored: true, file: rel, totalLines: restored.rows.length },
    }
  }

  async function grepExecute(rawInput: unknown, context: ToolCallContext) {
    // Read-only: peek del served-record + disco, nunca serve/commit.
    const input: ToolCallInput = (rawInput ?? {}) as ToolCallInput
    const { abs, rel } = resolveInProject(projectDir, input?.file)
    const pattern = input?.pattern
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro pattern requerido (string no vacío)")
    }
    if (isExcluded(rel, cfg.excludes)) {
      throw new AnchorStoreError("E_PATH_EXCLUDED", `Path excluido: "${rel}"`)
    }
    await readDisk(abs, rel)
    const store = storeFor(context.sessionID)
    const served = store.peek(rel)
    if (!served) {
      return {
        content: `H_READ_FIRST: "${rel}" no está servido en esta sesión; usa read para servirlo antes de buscar.`,
        metadata: { served: false, file: rel, pattern },
      }
    }
    // Literal case-sensitive (como replace_match): sin regex.
    const matches = served.filter((r) => r.content.includes(pattern))
    // Mismos topes que read: parseOffset/parseLimit/renderPage sobre matches.
    const startLine = parseOffset(input?.offset, (anchor) => {
      const idx = matches.findIndex((r) => r.anchor === anchor)
      if (idx < 0) {
        throw new AnchorStoreError(
          "E_INVALID_INPUT",
          `offset anchor no está entre las coincidencias: "${anchor}"`,
        )
      }
      return idx + 1
    })
    const limit = parseLimit(input?.limit, cfg.maxOutputLines)
    const page = renderPage(matches, startLine, limit, [], cfg)
    const lines = [`grep "${pattern}" in ${rel}: ${matches.length} match(es).`, page.text]
    return {
      content: lines.join("\n"),
      metadata: { served: true, file: rel, pattern, totalMatches: matches.length, ...page.metadata },
    }
  }

  const readDef = {
    name: "read",
    description: "Read a file served as anchor│content rows for stable anchor edits (paginated).",
    input: {
      type: "object",
      properties: {
        file: { type: "string", description: "Project-relative file path." },
        offset: {
          anyOf: [{ type: "number" }, { type: "string" }],
          description: "1-based line number or anchor to start from.",
        },
        limit: { type: "number", description: `Max rows (default ${cfg.maxOutputLines}).` },
      },
      required: ["file"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: readExecute,
  }
  const replaceDef = {
    name: "replace",
    description: "Replace a line range by anchor refs (verified against served-record).",
    input: {
      type: "object",
      properties: {
        file: { type: "string" },
        startAnchor: { type: "string" },
        endAnchor: { type: "string" },
        content: { type: "string", description: "Replacement text (lines joined with \\n)." },
      },
      required: ["file", "startAnchor", "content"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: replaceExecute,
  }
  const replaceMatchDef = {
    name: "replace_match",
    description: "Replace a single literal match of served text (verified against served-record).",
    input: {
      type: "object",
      properties: {
        file: { type: "string" },
        match: {
          type: "string",
          description: "Literal case-sensitive text to replace (exactly one occurrence in served content).",
        },
        content: { type: "string", description: "Replacement text." },
      },
      required: ["file", "match", "content"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: replaceMatchExecute,
  }
  const insertDef = {
    name: "insert",
    description: "Insert text before/after an anchor (verified against served-record).",
    input: {
      type: "object",
      properties: {
        file: { type: "string" },
        anchor: { type: "string" },
        position: { type: "string", enum: ["before", "after"] },
        content: { type: "string" },
      },
      required: ["file", "anchor", "position", "content"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: insertExecute,
  }
  const copyDef = {
    name: "copy",
    description: "Copy served lines to an already-served destination (verified against served-record).",
    input: {
      type: "object",
      properties: {
        file: { type: "string", description: "Project-relative source file path." },
        startAnchor: { type: "string" },
        endAnchor: { type: "string" },
        destFile: { type: "string", description: "Project-relative destination file path (already served)." },
        destAnchor: { type: "string" },
        position: { type: "string", enum: ["before", "after"] },
      },
      required: ["file", "startAnchor", "destFile", "destAnchor", "position"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: copyExecute,
  }
  const moveDef = {
    name: "move",
    description:
      "Move served lines to an already-served destination, emptying the source only after the destination commits (verified against served-record).",
    input: {
      type: "object",
      properties: {
        file: { type: "string", description: "Project-relative source file path." },
        startAnchor: { type: "string" },
        endAnchor: { type: "string" },
        destFile: { type: "string", description: "Project-relative destination file path (already served)." },
        destAnchor: { type: "string" },
        position: { type: "string", enum: ["before", "after"] },
      },
      required: ["file", "startAnchor", "destFile", "destAnchor", "position"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: moveExecute,
  }
  const grepDef = {
    name: "anchor_grep",
    description:
      "Search served anchors for a literal substring (read-only: never serves or mutates).",
    input: {
      type: "object",
      properties: {
        file: { type: "string", description: "Project-relative file path (must be served)." },
        pattern: { type: "string", description: "Literal case-sensitive substring to find." },
        offset: {
          anyOf: [{ type: "number" }, { type: "string" }],
          description: "1-based match number or anchor to start from.",
        },
        limit: { type: "number", description: `Max rows (default ${cfg.maxOutputLines}).` },
      },
      required: ["file", "pattern"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: grepExecute,
  }
  const undoDef = {
    name: "undo_last_change",
    description: "Restore a file to its pre-edit state (single-level per file, persistent).",
    input: {
      type: "object",
      properties: {
        file: { type: "string" },
      },
      required: ["file"],
      additionalProperties: false,
    },
    // Directas al provider como las nativas (codemode false): el modelo las
    // llama por nombre, imprescindible para el batch mismo-mensaje (#7).
    options: { codemode: false },
    execute: undoExecute,
  }

  await ctx.tool.transform((editor) => {
    if (editor.get("read")) {
      editor.update("read", (tool) => {
        tool.description = readDef.description
        tool.input = readDef.input
        tool.execute = readExecute
        // Nuestro execute devuelve {content, metadata}: sin output declarado
        // el host sirve `content` al modelo. Con el output nativo heredado el
        // host rechaza con "Tool did not return its declared output" (e2e #10).
        tool.output = undefined
        tool.options = readDef.options
      })
    } else {
      editor.add(readDef)
    }
    if (!editor.get("replace")) editor.add(replaceDef)
    if (!editor.get("replace_match")) editor.add(replaceMatchDef)
    if (!editor.get("insert")) editor.add(insertDef)
    if (!editor.get("copy")) editor.add(copyDef)
    if (!editor.get("move")) editor.add(moveDef)
    if (!editor.get("undo_last_change")) editor.add(undoDef)
    if (!editor.get("anchor_grep")) editor.add(grepDef)
  })

  return () => {
    batches.clear()
    for (const store of stores.values()) store.close()
    stores.clear()
  }
}
