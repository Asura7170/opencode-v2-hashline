import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAnchorStore } from "../src/anchor-store"
import { withProjectKeys } from "../src/config"
import {
  autoServeMentionedPaths,
  extractMentionedPaths,
  formatAutoReadNote,
} from "../src/atfile"

function project(): string {
  return mkdtempSync(join(tmpdir(), "t19-unit-"))
}

function memStore(sessionId = "s19") {
  return createAnchorStore({ sessionId, storePath: ":memory:" })
}

// AC: paths del proyecto mencionados en el mensaje quedan servidos.
describe("extractMentionedPaths", () => {
  test("extrae paths con extensión o slash, sin duplicados", () => {
    expect(extractMentionedPaths("revisa a.txt y sub/b.ts, luego a.txt")).toEqual([
      "a.txt",
      "sub/b.ts",
    ])
  })

  test("limpia puntuación y @ de mención", () => {
    expect(extractMentionedPaths('mira (@a.txt): "sub/b.ts".')).toEqual(["a.txt", "sub/b.ts"])
  })

  test("ignora palabras sin forma de path y URLs", () => {
    expect(extractMentionedPaths("esto no https://x.io/a.txt")).toEqual([])
  })
})

describe("autoServeMentionedPaths", () => {
  test("sirve el mencionado con la misma clave relativa de los tools", async () => {
    const dir = project()
    writeFileSync(join(dir, "b.txt"), "one\ntwo")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("revisa b.txt", dir, proj)
    expect(skipped).toEqual([])
    expect(served.map((s) => s.file)).toEqual(["b.txt"])
    expect(served[0].lines).toBe(2)
    // Misma served-record que vería `read`: peek por relativa del proyecto.
    expect(proj.peek(join(dir, "b.txt"))?.map((r) => r.content)).toEqual(["one", "two"])
    store.close()
  })

  test("respeta already: no re-sirve lo ya anotado como adjunto", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "x\ny")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served } = await autoServeMentionedPaths("a.txt", dir, proj, new Set(["a.txt"]))
    expect(served).toEqual([])
    expect(proj.peek(join(dir, "a.txt"))).toBeNull()
    store.close()
  })

  test("fuera del proyecto e ilegible se omiten sin romper (esqueleto del Gate #20)", async () => {
    const dir = project()
    writeFileSync(join(dir, "ok.txt"), "a\nb")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths(
      "mira ok.txt ../fuera.txt missing.txt",
      dir,
      proj,
    )
    expect(served.map((s) => s.file)).toEqual(["ok.txt"])
    // Sin conducta de skips en #19: el Gate del #20 los motivará.
    expect(skipped).toEqual([])
    store.close()
  })
})

describe("formatAutoReadNote", () => {
  test("null sin servidos; resumen con servidos y filas", () => {
    expect(formatAutoReadNote([], [])).toBeNull()
    const note = formatAutoReadNote(
      [{ file: "a.txt", lines: 2 }],
      [{ file: "b.txt", lines: 1, rows: [{ anchor: "abcd", line: 1, content: "one" }] }],
    )
    expect(note).toMatch(/H_AUTO_READ/)
    expect(note).toContain("a.txt (2 lines)")
    expect(note).toContain("b.txt (1 line)")
    expect(note).toContain("abcd│one")
  })
})
