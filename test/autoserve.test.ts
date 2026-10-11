import { describe, expect, test } from "bun:test"

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
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

function memStore(sessionId = "s19", opts: { maxAnchors?: number; maxFileBytes?: number } = {}) {
  return createAnchorStore({ sessionId, storePath: ":memory:", ...opts })
}

function sharedDb(name: string) {
  return join(mkdtempSync(join(tmpdir(), "t20-gate-")), `${name}.sqlite`)
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

  test("segmentos entrecomillados conservan paths con espacios", () => {
    expect(extractMentionedPaths('revisa "mi archivo.txt" y otro.txt')).toEqual([
      "mi archivo.txt",
      "otro.txt",
    ])
    expect(extractMentionedPaths("mira 'mi otro doc.md', luego c.txt.")).toEqual([
      "mi otro doc.md",
      "c.txt",
    ])
  })

  test("entrecomillado sin forma de path no rastrea libre", () => {
    expect(extractMentionedPaths('di "hola mundo" sin más')).toEqual([])
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

  test("fuera del proyecto se salta con nota; lo ilegible deja skip motivado", async () => {
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
    // Gate: fuera del proyecto deja nota motivada; lo ilegible (missing.txt,
    // borrado tras mencionar) también deja skip con nota, sin E_ nuevos.
    expect(skipped.map((s) => s.file)).toEqual(["../fuera.txt", "missing.txt"])
    expect(skipped[0].reason).toMatch(/fuera del proyecto/)
    expect(skipped[1].reason).toMatch(/no se pudo leer/)
    expect(skipped[1].reason).toMatch(/no existe o fue borrado/)
    for (const s of skipped) expect(s.reason).not.toMatch(/E_[A-Z_]+/)
    expect(proj.peek(join(dir, "missing.txt"))).toBeNull()
    store.close()
  })

  test("path con espacios entrecomillado queda servido", async () => {
    const dir = project()
    writeFileSync(join(dir, "mi archivo.txt"), "one\ntwo")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths(
      'revisa "mi archivo.txt" por favor',
      dir,
      proj,
    )
    expect(skipped).toEqual([])
    expect(served.map((s) => s.file)).toEqual(["mi archivo.txt"])
    expect(proj.peek(join(dir, "mi archivo.txt"))?.map((r) => r.content)).toEqual(["one", "two"])
    store.close()
  })

  test("directorio mencionado deja skip motivado, sin servir", async () => {
    const dir = project()
    mkdirSync(join(dir, "sub"))
    writeFileSync(join(dir, "ok.txt"), "a\nb")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("mira ok.txt sub/", dir, proj)
    expect(served.map((s) => s.file)).toEqual(["ok.txt"])
    expect(skipped.map((s) => s.file)).toEqual(["sub"])
    expect(skipped[0].reason).toMatch(/no se pudo leer/)
    expect(skipped[0].reason).toMatch(/directorio/)
    expect(skipped[0].reason).not.toMatch(/E_[A-Z_]+/)
    expect(proj.peek(join(dir, "sub"))).toBeNull()
    store.close()
  })
})

describe("Gate de skips #20", () => {
  test("dueño de otra sesión → skip con nota, sin robar ownership", async () => {
    const dir = project()
    writeFileSync(join(dir, "ajeno.txt"), "a1\na2")
    const db = sharedDb("ajeno")
    const otra = createAnchorStore({ sessionId: "s-otra", storePath: db })
    // Anchor REAL servido en sesión ajena (nunca inventado: "zzzz" daría
    // verde aunque la impl ensanchara served-record como efecto lateral).
    const foreignAnchor = otra.serve("ajeno.txt", "a1\na2").rows[0].anchor
    otra.close()
    const store = createAnchorStore({ sessionId: "s-mia", storePath: db })
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("revisa ajeno.txt", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["ajeno.txt"])
    expect(skipped[0].reason).toMatch(/otra sesi/)
    // Sin robar ni servir: el anchor ajeno sigue stale aquí, sin served-record.
    expect(() => store.resolve("ajeno.txt", foreignAnchor)).toThrow(/E_ANCHOR_STALE/)
    expect(proj.peek(join(dir, "ajeno.txt"))).toBeNull()
    store.close()
    // La otra sesión conserva ownership y sombras intactos.
    const vuelta = createAnchorStore({ sessionId: "s-otra", storePath: db })
    expect(vuelta.resolve("ajeno.txt", foreignAnchor)).toEqual({ line: 1, content: "a1" })
    vuelta.close()
  })

  test("cuota llena → skip con nota, sin reclamar LRU", async () => {
    const dir = project()
    writeFileSync(join(dir, "f1.txt"), "a\nb")
    writeFileSync(join(dir, "f2.txt"), "c\nd")
    writeFileSync(join(dir, "f3.txt"), "e\nf")
    const store = memStore("s1", { maxAnchors: 4 })
    const proj = withProjectKeys(store, dir)
    const f1 = proj.serve(join(dir, "f1.txt"), "a\nb").rows
    proj.serve(join(dir, "f2.txt"), "c\nd")
    const { served, skipped } = await autoServeMentionedPaths("mira f3.txt", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["f3.txt"])
    expect(skipped[0].reason).toMatch(/cuota/i)
    expect(skipped[0].reason).toMatch(/LRU/)
    // Sin reclamar: f1/f2 resuelven y f3 no deja served-record.
    expect(store.resolve("f1.txt", f1[0].anchor)).toEqual({ line: 1, content: "a" })
    expect(proj.peek(join(dir, "f2.txt"))?.map((r) => r.content)).toEqual(["c", "d"])
    expect(proj.peek(join(dir, "f3.txt"))).toBeNull()
    store.close()
  })

  test("excluido → skip con nota, sin servir", async () => {
    const dir = project()
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFileSync(join(dir, "dist", "app.min.js"), "x\ny")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("mira dist/app.min.js", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["dist/app.min.js"])
    expect(skipped[0].reason).toMatch(/excluido/i)
    expect(proj.peek(join(dir, "dist", "app.min.js"))).toBeNull()
    store.close()
  })

  test("oversize → skip con nota, sin servir", async () => {
    const dir = project()
    writeFileSync(join(dir, "big.txt"), "0123456789\n")
    const store = memStore("s1", { maxFileBytes: 8 })
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("mira big.txt", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["big.txt"])
    expect(skipped[0].reason).toMatch(/excede/)
    expect(proj.peek(join(dir, "big.txt"))).toBeNull()
    store.close()
  })

  test("excluido y ajeno → motivo excluido (orden del Gate)", async () => {
    const dir = project()
    writeFileSync(join(dir, "clash.min.js"), "x\ny")
    const db = sharedDb("excl-ajeno")
    // Clave relativa real servida en sesión ajena con excludes vacíos (con los
    // defaults no podría servirse: el anchor inventado queda prohibido).
    const otra = createAnchorStore({ sessionId: "s-otra", storePath: db, excludes: [] })
    const foreignAnchor = otra.serve("clash.min.js", "x\ny").rows[0].anchor
    otra.close()
    const store = createAnchorStore({ sessionId: "s-mia", storePath: db })
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("mira clash.min.js", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["clash.min.js"])
    expect(skipped[0].reason).toMatch(/excluido/i)
    expect(skipped[0].reason).not.toMatch(/otra sesi/)
    expect(skipped[0].reason).not.toMatch(/E_[A-Z_]+/)
    expect(proj.peek(join(dir, "clash.min.js"))).toBeNull()
    store.close()
    // La otra sesión conserva ownership intacto.
    const vuelta = createAnchorStore({ sessionId: "s-otra", storePath: db, excludes: [] })
    expect(vuelta.resolve("clash.min.js", foreignAnchor)).toEqual({ line: 1, content: "x" })
    vuelta.close()
  })

  test("oversize y ajeno → motivo oversize (orden del Gate)", async () => {
    const dir = project()
    writeFileSync(join(dir, "gordo.txt"), "0123456789\n")
    const db = sharedDb("gordo-ajeno")
    const otra = createAnchorStore({ sessionId: "s-otra", storePath: db })
    const foreignAnchor = otra.serve("gordo.txt", "0123456789\n").rows[0].anchor
    otra.close()
    const store = createAnchorStore({ sessionId: "s-mia", storePath: db, maxFileBytes: 8 })
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("mira gordo.txt", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["gordo.txt"])
    expect(skipped[0].reason).toMatch(/excede/)
    expect(skipped[0].reason).not.toMatch(/otra sesi/)
    expect(skipped[0].reason).not.toMatch(/E_[A-Z_]+/)
    expect(proj.peek(join(dir, "gordo.txt"))).toBeNull()
    store.close()
    const vuelta = createAnchorStore({ sessionId: "s-otra", storePath: db })
    expect(vuelta.resolve("gordo.txt", foreignAnchor)).toEqual({ line: 1, content: "0123456789" })
    vuelta.close()
  })

  test("ningún skip abre served-record: cero E_ nuevos en los motivos", async () => {
    const dir = project()
    writeFileSync(join(dir, "big.txt"), "0123456789\n")
    const store = memStore("s1", { maxFileBytes: 8 })
    const proj = withProjectKeys(store, dir)
    const { skipped } = await autoServeMentionedPaths("mira ../fuera.txt big.txt", dir, proj)
    expect(skipped).toHaveLength(2)
    for (const s of skipped) expect(s.reason).not.toMatch(/E_[A-Z_]+/)
    store.close()
  })
})

describe("formatAutoReadNote", () => {
  test("null sin servidos ni skips; resumen con servidos y filas", () => {
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

  test("cada skip viaja motivado en el resumen aunque nada se sirva", () => {
    const note = formatAutoReadNote(
      [],
      [],
      [{ file: "x.txt", reason: "dueño de otra sesión (no se roba ownership)" }],
    )
    expect(note).toMatch(/H_AUTO_READ/)
    expect(note).toContain("x.txt")
    expect(note).toContain("dueño de otra sesión")
  })
})
