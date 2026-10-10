import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { AnchorStoreError, type AnchorStore } from "./anchor-store"
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

function toFsPath(uri: string): string {
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
