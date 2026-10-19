import { existsSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { DEFAULT_EXCLUDES, errorCode, type AnchorStore } from "./anchor-store"

// Config sin UI (ticket #9, historia 16 del spec):
// archivo global < archivo de proyecto < opciones del plugin (ctx.options),
// cableada a límites y conducta. Claves desconocidas se rechazan.
export interface HashlineConfig {
  maxOutputLines: number
  maxOutputBytes: number
  maxLineChars: number
  maxFileBytes: number
  maxAnchors: number
  excludes: string[]
  /** Override del directorio sidecar; por defecto <proyecto>/.opencode/hashline. */
  storeDir?: string
}

export const DEFAULT_CONFIG: HashlineConfig = {
  maxOutputLines: 2000,
  maxOutputBytes: 50 * 1024,
  maxLineChars: 2000,
  maxFileBytes: 1_048_576,
  // Calibrado #16 (bench/bench-4096.ts, i5-12400F/48GB/Win11/bun 1.4.2):
  // ingest 2.91ms, align 1.79ms, commit 1.54ms a 4096 anchors (peor caso
  // 13.30ms, sin warnings de cuota); 4096 se queda.
  maxAnchors: 4096,
  excludes: [...DEFAULT_EXCLUDES],
}

const KNOWN_KEYS = new Set([
  "maxOutputLines",
  "maxOutputBytes",
  "maxLineChars",
  "maxFileBytes",
  "maxAnchors",
  "excludes",
  "storeDir",
])

export class ConfigError extends Error {
  readonly code = "E_INVALID_CONFIG"
  constructor(message: string) {
    super(`[E_INVALID_CONFIG] ${message}`)
    this.name = "ConfigError"
  }
}

function checkInt(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`"${key}" debe ser entero >= 1: ${JSON.stringify(value)}`)
  }
  return value
}

function checkExcludes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
    throw new ConfigError(`"excludes" debe ser string[] no vacío: ${JSON.stringify(value)}`)
  }
  return [...(value as string[])]
}

function checkStoreDir(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new ConfigError(`"storeDir" debe ser string no vacío: ${JSON.stringify(value)}`)
  }
  return value
}

// Mapa clave → validador: una sola fuente para claves conocidas y su forma.
const LAYER_VALIDATORS: Record<string, (value: unknown, key: string) => unknown> = {
  maxOutputLines: checkInt,
  maxOutputBytes: checkInt,
  maxLineChars: checkInt,
  maxFileBytes: checkInt,
  maxAnchors: checkInt,
  excludes: checkExcludes,
  storeDir: checkStoreDir,
}

// Sanitiza una capa (global, proyecto u opciones): desconocidas e inválidas rechazan.
export function sanitizeLayer(input: unknown, where: string): Partial<HashlineConfig> {
  if (input === undefined || input === null) return {}
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError(`capa ${where} debe ser objeto: ${JSON.stringify(input)}`)
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const validate = LAYER_VALIDATORS[key]
    if (!KNOWN_KEYS.has(key) || !validate) {
      throw new ConfigError(`clave desconocida "${key}" en ${where} (se rechaza)`)
    }
    out[key] = validate(value, key)
  }
  return out as Partial<HashlineConfig>
}

// Precedencia: cada capa gana a la anterior; sin capas → defaults del spec.
export function resolveConfig(layers: unknown[]): HashlineConfig {
  let merged: HashlineConfig = { ...DEFAULT_CONFIG, excludes: [...DEFAULT_CONFIG.excludes] }
  layers.forEach((layer, i) => {
    merged = { ...merged, ...sanitizeLayer(layer, `capa #${i}`) }
  })
  return merged
}

export function globalConfigPath(homeDir: string = homedir()): string {
  return join(homeDir, ".config", "opencode", "hashline", "config.json")
}

export function projectConfigPath(projectDir: string): string {
  return join(projectDir, ".opencode", "hashline", "config.json")
}

// Dueño canónico del sidecar (spec: <proyecto>/.opencode/hashline/<sesión>.sqlite).
// storeDir relativo se interpreta relativo al proyecto (no al cwd del host).
export function storePathFor(projectDir: string, sessionID: string, storeDir?: string): string {
  const safe = sessionID.replace(/[^a-zA-Z0-9_-]/g, "_") || "session"
  const base = storeDir
    ? isAbsolute(storeDir)
      ? storeDir
      : join(projectDir, storeDir)
    : join(projectDir, ".opencode", "hashline")
  return join(base, `${safe}.sqlite`)
}

async function loadLayer(path: string, where: string): Promise<Partial<HashlineConfig>> {
  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch (err) {
    if (errorCode(err) === "ENOENT") return {}
    throw new ConfigError(`no se pudo leer ${where} (${path}): ${err instanceof Error ? err.message : String(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigError(`JSON inválido en ${where} (${path})`)
  }
  return sanitizeLayer(parsed, where)
}

export interface LoadOptions {
  projectDir?: string
  globalPath?: string
  projectPath?: string
  options?: unknown
}

export async function loadHashlineConfig(load: LoadOptions = {}): Promise<HashlineConfig> {
  const globalPath = load.globalPath ?? globalConfigPath()
  const layers: unknown[] = [await loadLayer(globalPath, "config global")]
  if (load.projectDir) {
    layers.push(
      await loadLayer(load.projectPath ?? projectConfigPath(load.projectDir), "config de proyecto"),
    )
  } else if (load.projectPath) {
    layers.push(await loadLayer(load.projectPath, "config de proyecto"))
  }
  layers.push(sanitizeLayer(load.options, "opciones del plugin"))
  return resolveConfig(layers)
}

// Windows (FS case-insensitive): "A.ts" y "a.ts" son el mismo archivo; sin
// plegar el case cada capitalización abriría anchors distintos.
export function foldKey(rel: string, foldCase = process.platform === "win32"): string {
  return foldCase ? rel.toLowerCase() : rel
}

// Dentro del proyecto = ni la raíz misma ni un escape (.., ../, absoluto).
function withinProject(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

// Clave canónica de un path absoluto dentro del proyecto: contención léxica +
// real (un symlink/junction interno puede apuntar fuera) + separadores "/" +
// case plegado. No existente o ENOENT → sin veredicto realpath (el read
// posterior da E_FILE_NOT_FOUND).
export function projectKeyFor(projectDir: string, abs: string): string | null {
  let rel = relative(projectDir, abs)
  if (!withinProject(rel)) return null
  if (existsSync(abs)) {
    try {
      const realRel = relative(realpathSync(projectDir), realpathSync(abs))
      if (!withinProject(realRel)) return null
      rel = realRel
    } catch (err) {
      if (errorCode(err) !== "ENOENT") throw err
    }
  }
  return foldKey(rel.split(sep).join("/"))
}

// Unificación de claves (divergencia #5/#8): la admisión recibe paths absolutos
// (uris) y los tools claves relativas al proyecto; ambos deben caer al mismo
// served-record. Dentro del proyecto → relativa con "/"; fuera → null.
export function relativeKeyFor(projectDir: string, fsPath: string): string | null {
  const abs = isAbsolute(fsPath) ? fsPath : resolve(projectDir, fsPath)
  return projectKeyFor(projectDir, abs)
}

function keyForFile(projectDir: string, filePath: string): string {
  return relativeKeyFor(projectDir, filePath) ?? filePath.replace(/\\/g, "/")
}

// Vista del store compartido con claves de proyecto para el hook de admisión.
export function withProjectKeys(store: AnchorStore, projectDir: string): AnchorStore {
  return {
    sessionId: store.sessionId,
    serve: (filePath, content) => store.serve(keyForFile(projectDir, filePath), content),
    commit: (filePath, newContent, commitOpts) =>
      store.commit(keyForFile(projectDir, filePath), newContent, commitOpts),
    resolve: (filePath, anchor) => store.resolve(keyForFile(projectDir, filePath), anchor),
    resolveRange: (filePath, startAnchor, endAnchor) =>
      store.resolveRange(keyForFile(projectDir, filePath), startAnchor, endAnchor),
    peek: (filePath) => store.peek(keyForFile(projectDir, filePath)),
    checkServable: (filePath, content) =>
      store.checkServable(keyForFile(projectDir, filePath), content),
    usage: () => store.usage(),
    undoShadow: (filePath) => store.undoShadow(keyForFile(projectDir, filePath)),
    restoreShadow: (filePath, diskLines) =>
      store.restoreShadow(keyForFile(projectDir, filePath), diskLines),
    close: () => {},
  }
}
