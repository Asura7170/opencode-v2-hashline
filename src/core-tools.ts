import { mkdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  AnchorStoreError,
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

function formatRow(row: AnchorRow, maxLineChars: number): string {
  if (row.content.length > maxLineChars) {
    return `${row.anchor}│${row.content.slice(0, maxLineChars)} ⟨+${row.content.length - maxLineChars} chars⟩`
  }
  return `${row.anchor}│${row.content}`
}

function formatWarnings(warnings: { code: string; message: string }[]): string[] {
  return warnings.map((w) => `${w.code}: ${w.message}`)
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

  function ownStoreFor(sessionID: string): AnchorStore {
    const cached = stores.get(sessionID)
    if (cached) return cached
    const storePath = configStorePathFor(projectDir, sessionID, cfg.storeDir)
    mkdirSync(join(cfg.storeDir ?? join(projectDir, ".opencode", "hashline")), { recursive: true })
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
    const startLine = parseOffset(input?.offset, (anchor) => store.resolve(rel, anchor).line)
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
    const disk = await readDisk(abs, rel)
    const store = storeFor(context.sessionID)
    const oldRows = store.serve(rel, disk).rows
    const range = store.resolveRange(rel, startAnchor, endAnchor ?? startAnchor)
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
    checkNewContent(rel, newContent, cfg.maxFileBytes)
    await writeFile(abs, newContent, "utf-8")
    const committed = store.commit(rel, newContent)
    const removed = oldRows
      .slice(range.startLine - 1, range.endLine)
      .map((r) => `- ${formatRow(r, cfg.maxLineChars)}`)
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
    const disk = await readDisk(abs, rel)
    const store = storeFor(context.sessionID)
    store.serve(rel, disk)
    const resolved = store.resolve(rel, anchor)
    const diskLines = splitLines(disk)
    const newLines = splitLines(content)
    const idx = position === "before" ? resolved.line - 1 : resolved.line
    const newContent = [...diskLines.slice(0, idx), ...newLines, ...diskLines.slice(idx)].join("\n")
    checkNewContent(rel, newContent, cfg.maxFileBytes)
    await writeFile(abs, newContent, "utf-8")
    const committed = store.commit(rel, newContent)
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
    execute: insertExecute,
  }

  await ctx.tool.transform((editor: any) => {
    if (editor.get("read")) {
      editor.update("read", (tool: any) => {
        tool.description = readDef.description
        tool.input = readDef.input
        tool.execute = readExecute
      })
    } else {
      editor.add(readDef)
    }
    if (!editor.get("replace")) editor.add(replaceDef)
    if (!editor.get("insert")) editor.add(insertDef)
  })

  return () => {
    for (const store of stores.values()) store.close()
    stores.clear()
  }
}
