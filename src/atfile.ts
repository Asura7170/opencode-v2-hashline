import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { AnchorStoreError, type AnchorRow, type AnchorStore } from "./anchor-store"
import { relativeKeyFor } from "./config"
import { ANCHOR_SHAPE_SOURCE } from "./native-guards"

export interface PromptFile {
  uri: string
}

export interface AtFileSkip {
  uri: string
  code: string
  message: string
}

export interface AtFileState {
  dir: string | null
  counter: number
  temps: Set<string>
}

export function createAtFileState(): AtFileState {
  return { dir: null, counter: 0, temps: new Set() }
}

// Ya anotado: primera línea no vacía con forma anchor│contenido.
function alreadyAnnotated(content: string): boolean {
  const shape = new RegExp(ANCHOR_SHAPE_SOURCE)
  for (const line of content.split("\n")) {
    if (line === "") continue
    return shape.test(line)
  }
  return false
}

export function toFsPath(uri: string): string {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri
}

function toUriForm(fsPath: string, like: string): string {
  return like.startsWith("file://") ? pathToFileURL(fsPath).href : fsPath
}

function tempName(fsPath: string, counter: number): string {
  const base = basename(fsPath).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "attachment"
  return `${counter}-${base}`
}

// Anota cada adjunto files[] con anchors del store y hace swap de uri al
// temp anotado. Nunca lanza por un adjunto: lo problemático se omite pero
// los rechazos de guarda (excludes, binario, oversize) se devuelven con su
// código explícito para nota visible; reintentos, ya-anotados e ilegibles
// siguen silenciosos (no hay nada accionable que decir del store).
export async function annotateAttachments(
  files: PromptFile[] | undefined,
  store: AnchorStore,
  state: AtFileState,
): Promise<AtFileSkip[]> {
  if (!files) return []
  const skipped: AtFileSkip[] = []
  for (const file of files) {
    if (!file?.uri || state.temps.has(file.uri)) continue
    let fsPath: string
    try {
      fsPath = toFsPath(file.uri)
    } catch {
      continue
    }
    let content: string
    try {
      content = await readFile(fsPath, "utf-8")
    } catch {
      continue
    }
    if (alreadyAnnotated(content)) continue
    let annotated: string
    try {
      const { rows } = store.serve(fsPath, content)
      annotated = rows.map((r) => `${r.anchor}│${r.content}`).join("\n")
    } catch (err) {
      // E_PATH_EXCLUDED | E_FILE_OVERSIZE | E_FILE_BINARY: explícito sin
      // romper la admisión (el caller lo vuelve nota visible).
      if (err instanceof AnchorStoreError) {
        skipped.push({ uri: file.uri, code: err.code, message: err.message })
      }
      continue
    }
    if (state.dir === null) {
      state.dir = join(tmpdir(), `opencode-hashline-${process.pid}-${Date.now()}`)
      await mkdir(state.dir, { recursive: true })
    }
    const tempPath = join(state.dir, tempName(fsPath, state.counter++))
    try {
      await writeFile(tempPath, annotated, "utf-8")
    } catch {
      continue
    }
    file.uri = toUriForm(tempPath, file.uri)
    state.temps.add(file.uri)
  }
  return skipped
}

export async function cleanupAtFile(state: AtFileState): Promise<void> {
  state.temps.clear()
  if (state.dir !== null) {
    const dir = state.dir
    state.dir = null
    await rm(dir, { recursive: true, force: true })
  }
}

export interface AutoServeServed {
  file: string
  lines: number
  rows: AnchorRow[]
}

// Esqueleto del Gate (#20): cada skip con su motivo, sin E_ nuevos.
// En el camino feliz del #19 siempre viaja vacío.
export interface AutoServeSkip {
  file: string
  reason: string
}

export interface AutoServeSummary {
  file: string
  lines: number
}

// shortcut: solo tokens con '.'/'/'/'\' prueban disco; sin él cada palabra costaría un read.
export function extractMentionedPaths(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/\s+/)) {
    const tok = raw.replace(/^[@<('"[`]+/, "").replace(/[.,;:!?)"'`\]>]+$/, "")
    if (tok.length === 0 || tok.length > 256) continue
    if (!tok.includes("/") && !tok.includes(".") && !tok.includes("\\")) continue
    if (tok.includes("://")) continue
    if (!seen.has(tok)) seen.add(tok)
  }
  return [...seen]
}

// Auto-read del #19: sirve lo mencionado con la misma clave relativa que
// los tools, para que aguas abajo sea indistinguible de un `read` manual.
// Gate (ADR-0001, conducta del #20): peek-first ante dueño ajeno, Cuota con
// holgura sin reclamar, fuera/excluido/oversize con nota; tope 10 del #21.
// shortcut: sin peek-first ni Cuota ni tope hasta el #20/#21; aquí solo
// claves frescas en proyectos pequeños, lo demás se omite sin conducta.
export async function autoServeMentionedPaths(
  text: string,
  projectDir: string,
  store: AnchorStore,
  already?: Set<string>,
): Promise<{ served: AutoServeServed[]; skipped: AutoServeSkip[] }> {
  const served: AutoServeServed[] = []
  const seen = new Set<string>()
  for (const tok of extractMentionedPaths(text)) {
    const abs = resolve(projectDir, tok)
    if (seen.has(abs)) continue
    seen.add(abs)
    const rel = relativeKeyFor(projectDir, abs)
    if (rel === null || already?.has(rel)) continue
    let content: string
    try {
      content = await readFile(abs, "utf-8")
    } catch {
      continue
    }
    let rows: AnchorRow[]
    try {
      rows = store.serve(abs, content).rows
    } catch (err) {
      if (err instanceof AnchorStoreError) continue
      throw err
    }
    served.push({ file: rel, lines: rows.length, rows })
  }
  return { served, skipped: [] }
}

// Resumen por mensaje: una línea H_ con todo lo auto-servido (adjuntos
// anotados + mencionados) y las filas de los mencionados, que no tienen
// temp donde mostrarse. Null si nada se sirvió.
export function formatAutoReadNote(
  attachments: AutoServeSummary[],
  mentioned: AutoServeServed[],
): string | null {
  const all: AutoServeSummary[] = [...attachments, ...mentioned]
  if (all.length === 0) return null
  const head = `H_AUTO_READ: served ${all.length} file(s): ${all.map((s) => `${s.file} (${s.lines} line${s.lines === 1 ? "" : "s"})`).join("; ")}.`
  const sections = mentioned.map(
    (m) => `${m.file}:\n${m.rows.map((r) => `${r.anchor}│${r.content}`).join("\n")}`,
  )
  return `\n${[head, ...sections].join("\n")}`
}
