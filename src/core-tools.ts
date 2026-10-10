import { mkdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  AnchorStoreError,
  StaleAnchorError,
  createAnchorStore,
  type AnchorRow,
  type AnchorStore,
} from "./anchor-store"

import {
  DEFAULT_CONFIG,
  loadHashlineConfig,
  storePathFor as configStorePathFor,
  type HashlineConfig,
} from "./config"

// Defaults del spec (ticket #9): los gobierna la config
// (global < proyecto < opciones); aquí solo quedan como re-export estable.
export const MAX_OUTPUT_LINES = DEFAULT_CONFIG.maxOutputLines
export const MAX_OUTPUT_BYTES = DEFAULT_CONFIG.maxOutputBytes
export const MAX_LINE_CHARS = DEFAULT_CONFIG.maxLineChars
const MAX_FILE_BYTES = DEFAULT_CONFIG.maxFileBytes

export function storePathFor(projectDir: string, sessionID: string): string {
  return configStorePathFor(projectDir, sessionID)
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n")
}

function resolveInProject(projectDir: string, file: unknown): { abs: string; rel: string } {
  if (typeof file !== "string" || file.length === 0) {
    throw new AnchorStoreError("E_INVALID_INPUT", "Parámetro file requerido (string no vacío)")
  }
  const abs = resolve(projectDir, file)
  const rel = relative(projectDir, abs)
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new AnchorStoreError("E_PATH_EXCLUDED", `Path fuera del proyecto: "${file}"`)
  }
  return { abs, rel: rel.split(sep).join("/") }
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

async function readDisk(abs: string, rel: string): Promise<string> {
  try {
    return await readFile(abs, "utf-8")
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new AnchorStoreError("E_FILE_NOT_FOUND", `No existe: "${rel}"`)
    }
    if (err?.code === "EISDIR") {
      throw new AnchorStoreError("E_INVALID_INPUT", `No es un archivo: "${rel}"`)
    }
    throw err
  }
}

export interface CoreToolsDeps {
  /** Config ya resuelta por el entry (precedencia global < proyecto < opciones). */
  config?: HashlineConfig
  /** Store compartido por sesión (unificación admisión/tools del ticket #9). */
  storeFor?: (sessionID: string) => AnchorStore
}

export async function registerCoreTools(ctx: any, deps?: CoreToolsDeps): Promise<() => void> {
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
    } catch (err: any) {
      if (batch) batch.aborted = typeof err?.code === "string" ? err.code : "E_FILE_WRITE"
      if (err instanceof AnchorStoreError) {
        err.message += ` (H_BATCH_ABORTED: batch para "${rel}" abortado)`
        throw err
      }
      throw new AnchorStoreError(
        "E_FILE_WRITE",
        `No se pudo escribir "${rel}": ${err?.message ?? String(err)} (H_BATCH_ABORTED: batch para "${rel}" abortado)`,
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

  async function readExecute(input: any, context: any) {
    const { abs, rel } = resolveInProject(projectDir, input?.file)
    const disk = await readDisk(abs, rel)
    const store = storeFor(context.sessionID)
    const served = store.serve(rel, disk)
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

  async function replaceExecute(input: any, context: any) {
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
    const oldRows = await tracked(batch, rel, async () => store.serve(rel, disk).rows)
    let range
    try {
      range = store.resolveRange(rel, startAnchor, endAnchor ?? startAnchor)
    } catch (err) {
      if (err instanceof StaleAnchorError) throw withCurrentRows(err, cfg.maxLineChars)
      throw err
    }
    assertDisjoint(
      batch,
      rel,
      oldRows.slice(range.startLine - 1, range.endLine).map((r) => r.anchor),
      `rango ${startAnchor}-${endAnchor ?? startAnchor}`,
    )
    const diskLines = splitLines(disk)
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
    await tracked(batch, rel, async () => {
      checkNewContent(rel, newContent, cfg.maxFileBytes)
    })
    await tracked(batch, rel, () => writeFile(abs, newContent, "utf-8"))
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

  async function insertExecute(input: any, context: any) {
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
      store.serve(rel, disk)
    })
    let resolved
    try {
      resolved = store.resolve(rel, anchor)
    } catch (err) {
      if (err instanceof StaleAnchorError) throw withCurrentRows(err, cfg.maxLineChars)
      throw err
    }
    assertDisjoint(batch, rel, [anchor], `insert en "${anchor}"`)
    const diskLines = splitLines(disk)
    const newLines = splitLines(content)
    const idx = position === "before" ? resolved.line - 1 : resolved.line
    const newContent = [...diskLines.slice(0, idx), ...newLines, ...diskLines.slice(idx)].join("\n")
    await tracked(batch, rel, async () => {
      checkNewContent(rel, newContent, cfg.maxFileBytes)
    })
    await tracked(batch, rel, () => writeFile(abs, newContent, "utf-8"))
    const committed = await tracked(batch, rel, () =>
      Promise.resolve(
        batch && batch.commits > 0
          ? store.commit(rel, newContent, { keepShadow: true })
          : store.commit(rel, newContent),
      ),
    )
    if (batch) {
      batch.commits++
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

  async function undoExecute(input: any, context: any) {
    const { abs, rel } = resolveInProject(projectDir, input?.file)
    let diskLines: string[] | null
    try {
      diskLines = splitLines(await readDisk(abs, rel))
    } catch (err: any) {
      // Archivo borrado tras el edit: se recrea desde la sombra.
      if (err instanceof AnchorStoreError && err.code === "E_FILE_NOT_FOUND") diskLines = null
      else throw err
    }
    const store = storeFor(context.sessionID)
    const restored = store.restoreShadow(rel, diskLines)
    const newContent = restored.rows.map((r) => r.content).join("\n")
    await writeFile(abs, newContent, "utf-8")
    // El undo cierra los batches abiertos de este archivo: el próximo edit
    // abre un nivel de undo fresco.
    const sessionID = context?.sessionID
    if (typeof sessionID === "string") {
      for (const key of [...batches.keys()]) {
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

  await ctx.tool.transform((editor: any) => {
    if (editor.get("read")) {
      editor.update("read", (tool: any) => {
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
    if (!editor.get("insert")) editor.add(insertDef)
    if (!editor.get("undo_last_change")) editor.add(undoDef)
  })

  return () => {
    batches.clear()
    for (const store of stores.values()) store.close()
    stores.clear()
  }
}
