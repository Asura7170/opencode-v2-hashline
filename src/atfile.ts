import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { AnchorStoreError, errorCode, type AnchorRow, type AnchorStore } from "./anchor-store"
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

// Esqueleto del Gate (#20): skip de mención explícita, Cuota o tope, sin E_ nuevos.
// En el camino feliz del #19 siempre viaja vacío.
export interface AutoServeSkip {
  file: string
  reason: string
}

export interface AutoServeSummary {
  file: string
  lines: number
}

// Tope fijo del #21 (spec fase 3: número fijo y pequeño, sin bench ni
// tuning; cero claves nuevas de config): como máximo se auto-sirven 10
// archivos por mensaje; el resto queda en nota. Cuenta servidos, no
// intentos: un skip del Gate no consume cupo.
const MAX_AUTO_READ_PER_MESSAGE = 10

export interface MentionRef {
  token: string
  explicit: boolean
}

// shortcut: solo tokens con '.'/'/'/'\' prueban disco; sin él cada palabra costaría un read.
// La comilla solo abre segmento si empieza token (cur vacío): el apóstrofo de
// "don't" sigue literal y no traga el resto del mensaje.
// `explicit` = el token venía con `@` (tras comillas/corchetes iniciales): su
// fallo sí se nota; una mención desnuda solo se sirve si el archivo existe.
export function extractMentionedRefs(text: string): MentionRef[] {
  const refs = new Map<string, MentionRef>()
  const push = (raw: string): void => {
    const explicit = raw.replace(/^[<('"[`]+/, "").startsWith("@")
    const tok = raw.replace(/^[@<('"[`]+/, "").replace(/[.,;:!?)"'`\]>]+$/, "")
    if (tok.length === 0 || tok.length > 256) return
    if (!tok.includes("/") && !tok.includes(".") && !tok.includes("\\")) return
    if (tok.includes("://")) return
    const prev = refs.get(tok)
    if (prev === undefined) refs.set(tok, { token: tok, explicit })
    else if (explicit) prev.explicit = true
  }
  let cur = ""
  let quote: string | null = null
  const flush = (): void => {
    if (cur !== "") {
      push(cur)
      cur = ""
    }
  }
  for (const c of text) {
    if (quote !== null) {
      if (c === quote) {
        flush()
        quote = null
      } else {
        cur += c
      }
    } else if ((c === '"' || c === "'") && cur === "") {
      quote = c
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      flush()
    } else {
      cur += c
    }
  }
  flush()
  return [...refs.values()]
}

// Compatibilidad de API/tests: los tokens en orden, sin la marca de mención.
export function extractMentionedPaths(text: string): string[] {
  return extractMentionedRefs(text).map((r) => r.token)
}

// Secretos que el AUTO-READ no sirve ni anota, aunque la mención sea `@`.
function isSensitiveAutoRead(rel: string): boolean {
  const name = basename(rel)
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".pem") || name.endsWith(".key")
}

// Ilegible en disco (borrado, permiso, directorio): solo la mención explícita
// lo nota, sin E_ nuevos (US7). errorCode trae el código del SO (ENOENT, EACCES…).
function unreadableReason(code: string | undefined): string {
  if (code === "ENOENT") return "no se pudo leer (no existe o fue borrado)"
  if (code === "EACCES" || code === "EPERM") return "no se pudo leer (sin permiso de lectura)"
  if (code === "EISDIR") return "no se pudo leer (es un directorio, no un archivo)"
  return "no se pudo leer (ilegible desde disco)"
}

// Auto-read del #19: sirve lo mencionado con la misma clave relativa que
// los tools, para que aguas abajo sea indistinguible de un `read` manual.
// Gate en orden (ADR-0001): dentro del proyecto → excluido (antes de disco)
// → servible (ilegible, US7) → oversize/binario → Cuota con holgura → tope 10.
// Una mención desnuda (sin `@`) solo se sirve si existe y es servible: sus
// fallos callan; la `@ruta` sí deja nota motivada. Cuota y tope 10 notan
// siempre (son archivos reales que no se sirvieron). Los sidecars son por
// sesión: re-servir lo servido por otra sesión es válido (nada compartido).
// Todo skip es lectura sin efectos: ningún skip abre served-record. Tope del #21.
export async function autoServeMentionedPaths(
  text: string,
  projectDir: string,
  store: AnchorStore,
  already?: Set<string>,
): Promise<{ served: AutoServeServed[]; skipped: AutoServeSkip[] }> {
  const served: AutoServeServed[] = []
  const skipped: AutoServeSkip[] = []
  const seen = new Set<string>()
  // Los adjuntos ya servidos en este mensaje consumen cupo del tope.
  const servedBudget = (): number => (already?.size ?? 0) + served.length
  // Rechazo de guarda: solo la mención explícita lo nota (sin código E_).
  const gateNote = (err: unknown): string | null =>
    err instanceof AnchorStoreError ? err.message.replace(/^\[[^\]]+\] /, "") : null
  for (const ref of extractMentionedRefs(text)) {
    const tok = ref.token
    const abs = resolve(projectDir, tok)
    const rel = relativeKeyFor(projectDir, abs)
    // Dedupe por clave de proyecto: en Windows dos menciones del mismo archivo
    // con distinto case comparten rel; fuera del proyecto la clave sigue siendo abs.
    const seenKey = rel ?? abs
    if (seen.has(seenKey)) continue
    seen.add(seenKey)
    if (rel === null) {
      if (ref.explicit) {
        skipped.push({
          file: tok,
          reason: "fuera del proyecto (el Gate no abre lo que read rechaza)",
        })
      }
      continue
    }
    // Secretos: nunca viajan por AUTO-READ, ni con `@` (silencio, sin nota).
    if (isSensitiveAutoRead(rel)) continue
    if (already?.has(rel)) continue
    // Excluido antes de disco: con contenido vacío solo pican
    // excluido/extensión, sin mutar served-record.
    try {
      store.checkServable(abs, "")
    } catch (err) {
      const reason = gateNote(err)
      if (reason === null) throw err
      if (ref.explicit) skipped.push({ file: rel, reason })
      continue
    }
    let content: string
    try {
      content = await readFile(abs, "utf-8")
    } catch (err) {
      if (ref.explicit) skipped.push({ file: rel, reason: unreadableReason(errorCode(err)) })
      continue
    }
    // Oversize/binario antes de Cuota.
    try {
      store.checkServable(abs, content)
    } catch (err) {
      const reason = gateNote(err)
      if (reason === null) throw err
      if (ref.explicit) skipped.push({ file: rel, reason })
      continue
    }
    // Cuota con holgura: solo sirve si cabe, nunca reclama LRU. Re-servir lo
    // propio descuenta lo ya servido (neto real del ingest, que libera antes).
    const lines = content.replace(/\r\n/g, "\n").split("\n").length
    const netNew = lines - (store.peek(abs)?.length ?? 0)
    const quota = store.usage()
    if (netNew > 0 && quota.used + netNew > quota.max) {
      skipped.push({
        file: rel,
        reason: `sin Cuota libre bajo maxAnchors ${quota.max} (${quota.used} en uso, ${lines} pedidas; no se reclama LRU)`,
      })
      continue
    }
    // Tope 10 (#21, último del Gate): solo frena lo que pasaría todo lo
    // anterior; los skips del Gate ya continuaron sin tocar el cupo.
    if (servedBudget() >= MAX_AUTO_READ_PER_MESSAGE) {
      skipped.push({
        file: rel,
        reason: "tope 10 por mensaje (los 10 primeros se sirven, el resto queda en nota)",
      })
      continue
    }
    let rows: AnchorRow[]
    try {
      rows = store.serve(abs, content).rows
    } catch (err) {
      // Red de carrera: el precheck ya pasó; si el disco cambió entremedias
      // el rechazo no muta el served-record y viaja como nota sin código E_.
      const reason = gateNote(err)
      if (reason === null) throw err
      skipped.push({ file: rel, reason })
      continue
    }
    served.push({ file: rel, lines: rows.length, rows })
  }
  return { served, skipped }
}

// Tope de filas inlineadas en la nota (sumando archivos): el head ya resume
// cada uno; más de 200 filas solo infla el mensaje.
const MAX_NOTE_ROWS = 200

// Resumen por mensaje: una línea H_ con todo lo auto-servido (adjuntos
// anotados + mencionados), cada skip motivado y las filas de los
// mencionados (hasta MAX_NOTE_ROWS), que no tienen temp donde mostrarse.
// Null si nada se sirvió ni se saltó.
export function formatAutoReadNote(
  attachments: AutoServeSummary[],
  mentioned: AutoServeServed[],
  skipped: AutoServeSkip[] = [],
): string | null {
  const all: AutoServeSummary[] = [...attachments, ...mentioned]
  if (all.length === 0 && skipped.length === 0) return null
  const parts: string[] = []
  if (all.length > 0) {
    parts.push(`served ${all.length} file(s): ${all.map((s) => `${s.file} (${s.lines} line${s.lines === 1 ? "" : "s"})`).join("; ")}.`)
  }
  if (skipped.length > 0) {
    parts.push(
      `skipped ${skipped.length} file(s): ${skipped.map((s) => `${s.file} (${s.reason})`).join("; ")}.`,
    )
  }
  const head = `H_AUTO_READ: ${parts.join(" ")}`
  let remaining = MAX_NOTE_ROWS
  const sections = mentioned.map((m) => {
    const shown = m.rows.slice(0, remaining)
    remaining -= shown.length
    const body = shown.map((r) => `${r.anchor}│${r.content}`).join("\n")
    const hidden = m.rows.length - shown.length
    return `${m.file}:\n${body}${hidden > 0 ? `\n… (+${hidden} line(s) not shown)` : ""}`
  })
  return `\n${[head, ...sections].join("\n")}`
}
