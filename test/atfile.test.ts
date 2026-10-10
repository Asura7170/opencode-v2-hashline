import { describe, expect, test } from "bun:test"

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { readFile } from "node:fs/promises"

import { createAnchorStore } from "../src/anchor-store"
import {
  annotateAttachments,
  cleanupAtFile,
  createAtFileState,
} from "../src/atfile"

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "t8-fix-"))
}

function writeFixture(dir: string, name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

function memStore(sessionId = "s8") {
  return createAnchorStore({ sessionId, storePath: ":memory:" })
}

// Costura: efecto del hook de admisión sobre files[] (spec #1, historia 11).
// Sin host: se verifica files in/out + temps escritos + served-record.
describe("admisión @file", () => {
  test("anota adjunto con anchors y hace swap de uri al temp", async () => {
    const dir = fixtureDir()
    const src = writeFixture(dir, "a.ts", "one\ntwo\nthree")
    const store = memStore()
    const state = createAtFileState()
    const files = [{ uri: src }]
    await annotateAttachments(files, store, state)
    expect(files[0].uri).not.toBe(src)
    expect(files[0].uri.startsWith(tmpdir())).toBe(true)
    const temp = await readFile(files[0].uri, "utf-8")
    const lines = temp.split("\n")
    expect(lines).toHaveLength(3)
    // Sin prefijo numérico del host: el host lo añade aguas abajo.
    for (const [i, line] of lines.entries()) {
      expect(line).toMatch(/^[a-z]{4}│/)
      expect(line).not.toMatch(/^\d+: /)
      expect(lines[i].split("│")[1]).toBe(["one", "two", "three"][i])
    }
    expect(new Set(lines.map((l) => l.split("│")[0])).size).toBe(3)
    // Served-record: los anchors del temp resuelven contra el path original.
    const anchor = lines[1].split("│")[0]
    expect(store.resolve(src, anchor)).toEqual({ line: 2, content: "two" })
    store.close()
    await cleanupAtFile(state)
  })

  test("retry-safe: segunda pasada no re-anota ni rota anchors", async () => {
    const dir = fixtureDir()
    const src = writeFixture(dir, "a.ts", "one\ntwo")
    const store = memStore()
    const state = createAtFileState()
    const files = [{ uri: src }]
    await annotateAttachments(files, store, state)
    const firstUri = files[0].uri
    const firstTemp = await readFile(firstUri, "utf-8")
    await annotateAttachments(files, store, state)
    expect(files[0].uri).toBe(firstUri)
    expect(await readFile(firstUri, "utf-8")).toBe(firstTemp)
    expect(state.temps.size).toBe(1)
    store.close()
    await cleanupAtFile(state)
  })

  test("contenido ya anotado se deja intacto", async () => {
    const dir = fixtureDir()
    const src = writeFixture(dir, "a.ts", "abcd│one\nefgh│two")
    const store = memStore()
    const state = createAtFileState()
    const files = [{ uri: src }]
    await annotateAttachments(files, store, state)
    expect(files[0].uri).toBe(src)
    expect(state.temps.size).toBe(0)
    store.close()
    await cleanupAtFile(state)
  })

  test("respeta excludes y límites: omitidos sin swap", async () => {
    const dir = fixtureDir()
    const store = memStore()
    const state = createAtFileState()
    mkdirSync(join(dir, "node_modules", "lib"), { recursive: true })
    const excluded = join(dir, "node_modules", "lib", "a.ts")
    writeFileSync(excluded, "a\nb")
    const files = [
      { uri: excluded },
      { uri: writeFixture(dir, "logo.png", "fakepng") },
      { uri: writeFixture(dir, "bin.dat", "ab\0cd") },
      { uri: writeFixture(dir, "big.ts", "x".repeat(1_048_577)) },
    ]
    const before = files.map((f) => f.uri)
    const skipped = await annotateAttachments(files, store, state)
    expect(files.map((f) => f.uri)).toEqual(before)
    expect(state.temps.size).toBe(0)
    // Explícito, no silencioso: cada omitido reporta su código de guarda.
    expect(skipped.map((s) => s.code)).toEqual([
      "E_PATH_EXCLUDED",
      "E_FILE_BINARY",
      "E_FILE_BINARY",
      "E_FILE_OVERSIZE",
    ])
    expect(skipped.map((s) => s.uri)).toEqual(before)
    store.close()
    await cleanupAtFile(state)
  })

  test("omitidos explícitos no incluyen reintentos ni ya-anotados", async () => {
    const dir = fixtureDir()
    const src = writeFixture(dir, "a.ts", "one\ntwo")
    const store = memStore()
    const state = createAtFileState()
    const files = [{ uri: src }]
    const first = await annotateAttachments(files, store, state)
    expect(first).toEqual([])
    // Segunda pasada retry-safe: sin ruido nuevo.
    expect(await annotateAttachments(files, store, state)).toEqual([])
    const annotated = [{ uri: writeFixture(dir, "b.ts", "abcd│one") }]
    expect(await annotateAttachments(annotated, store, state)).toEqual([])
    store.close()
    await cleanupAtFile(state)
  })

  test("adjunto ilegible se omite sin romper a los demás", async () => {
    const dir = fixtureDir()
    const good = writeFixture(dir, "ok.ts", "a\nb")
    const store = memStore()
    const state = createAtFileState()
    const files = [{ uri: join(dir, "missing.ts") }, { uri: good }]
    await annotateAttachments(files, store, state)
    expect(files[0].uri).toBe(join(dir, "missing.ts"))
    expect(files[1].uri).not.toBe(good)
    store.close()
    await cleanupAtFile(state)
  })

  test("uri file:// se devuelve en forma file://", async () => {
    const dir = fixtureDir()
    const src = writeFixture(dir, "a.ts", "one\ntwo")
    const store = memStore()
    const state = createAtFileState()
    const files = [{ uri: pathToFileURL(src).href }]
    await annotateAttachments(files, store, state)
    expect(files[0].uri.startsWith("file://")).toBe(true)
    // Segunda pasada con forma file:// también es retry-safe.
    const firstUri = files[0].uri
    await annotateAttachments(files, store, state)
    expect(files[0].uri).toBe(firstUri)
    store.close()
    await cleanupAtFile(state)
  })

  test("sin files no hace nada", async () => {
    const store = memStore()
    const state = createAtFileState()
    await annotateAttachments(undefined, store, state)
    await annotateAttachments([], store, state)
    expect(state.temps.size).toBe(0)
    store.close()
    await cleanupAtFile(state)
  })

  test("cleanup elimina los temps registrados", async () => {
    const dir = fixtureDir()
    const src = writeFixture(dir, "a.ts", "one\ntwo")
    const store = memStore()
    const state = createAtFileState()
    const files = [{ uri: src }]
    await annotateAttachments(files, store, state)
    const temp = files[0].uri
    await cleanupAtFile(state)
    await expect(readFile(temp, "utf-8")).rejects.toThrow()
    expect(state.temps.size).toBe(0)
    store.close()
  })
})
