import { describe, expect, test } from "bun:test"

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAnchorStore } from "../src/anchor-store"
import { withProjectKeys } from "../src/config"
import {
  autoServeMentionedPaths,
  extractMentionedPaths,
  extractMentionedRefs,
  formatAutoReadNote,
} from "../src/atfile"

// Windows sin developer mode: symlinkSync da EPERM/EACCES → se salta el caso.
function symlinksSupported(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "t19-link-probe-"))
  try {
    writeFileSync(join(dir, "target"), "x")
    symlinkSync(join(dir, "target"), join(dir, "link"))
    return true
  } catch {
    return false
  }
}

const SYMLINKS = symlinksSupported()

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

describe("extractMentionedRefs", () => {
  test("marca explícito solo el token con @; el dedupe gana explícito", () => {
    expect(extractMentionedRefs("revisa a.txt y (@a.txt)")).toEqual([
      { token: "a.txt", explicit: true },
    ])
    expect(extractMentionedRefs("`@sub/b.ts` y c.md")).toEqual([
      { token: "sub/b.ts", explicit: true },
      { token: "c.md", explicit: false },
    ])
  })

  test('@"ruta con espacios" abre comilla tras la @; el apóstrofo de don\'t no', () => {
    expect(extractMentionedRefs('@"src/a b.ts"')).toEqual([
      { token: "src/a b.ts", explicit: true },
    ])
    expect(extractMentionedRefs("don't revisa a.txt")).toEqual([{ token: "a.txt", explicit: false }])
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
      "mira ok.txt @../fuera.txt @missing.txt",
      dir,
      proj,
    )
    expect(served.map((s) => s.file)).toEqual(["ok.txt"])
    // Gate: fuera del proyecto y lo ilegible notan solo con mención `@`;
    // sin E_ nuevos.
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

  test('@"path con espacios" (mención explícita) queda servido', async () => {
    const dir = project()
    writeFileSync(join(dir, "mi archivo.txt"), "one\ntwo")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths(
      'revisa @"mi archivo.txt" por favor',
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
    const { served, skipped } = await autoServeMentionedPaths("mira ok.txt @sub/", dir, proj)
    expect(served.map((s) => s.file)).toEqual(["ok.txt"])
    expect(skipped.map((s) => s.file)).toEqual(["sub"])
    expect(skipped[0].reason).toMatch(/no se pudo leer/)
    expect(skipped[0].reason).toMatch(/directorio/)
    expect(skipped[0].reason).not.toMatch(/E_[A-Z_]+/)
    expect(proj.peek(join(dir, "sub"))).toBeNull()
    store.close()
  })

  // Windows (FS case-insensitive): el dedupe por clave de proyecto sirve una
  // sola vez el mismo archivo mencionado con distinta capitalización.
  test.skipIf(process.platform !== "win32")(
    "case-insensitive: dos menciones del mismo archivo se sirven una vez",
    async () => {
      const dir = project()
      writeFileSync(join(dir, "MixedCase.txt"), "one\ntwo")
      const store = memStore()
      const proj = withProjectKeys(store, dir)
      const { served, skipped } = await autoServeMentionedPaths(
        "revisa MixedCase.txt y mixedcase.txt",
        dir,
        proj,
      )
      expect(skipped).toEqual([])
      expect(served.map((s) => s.file)).toEqual(["mixedcase.txt"])
      store.close()
    },
  )
})

describe("política de menciones (@ vs desnudas)", () => {
  test("prosa del reporte no genera candidatos ni nota", async () => {
    const dir = project()
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths(
      "analiza prompt/input, ia/agente y toque/edite; usa ^2.0.32",
      dir,
      proj,
    )
    expect(served).toEqual([])
    expect(skipped).toEqual([])
    expect(formatAutoReadNote([], served, skipped)).toBeNull()
    store.close()
  })

  test("existente sin @ se sirve; inexistente sin @ calla", async () => {
    const dir = project()
    writeFileSync(join(dir, "b.txt"), "one\ntwo")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("revisa b.txt y missing.txt", dir, proj)
    expect(served.map((s) => s.file)).toEqual(["b.txt"])
    expect(skipped).toEqual([])
    store.close()
  })

  test("@missing.txt deja skip motivado", async () => {
    const dir = project()
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("revisa @missing.txt", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["missing.txt"])
    expect(skipped[0].reason).toMatch(/no existe o fue borrado/)
    store.close()
  })

  test("fuera del proyecto: sin @ calla, con @ nota", async () => {
    const dir = project()
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const silent = await autoServeMentionedPaths("revisa ../fuera.txt", dir, proj)
    expect(silent.served).toEqual([])
    expect(silent.skipped).toEqual([])
    const noted = await autoServeMentionedPaths("revisa @../fuera.txt", dir, proj)
    expect(noted.skipped.map((s) => s.file)).toEqual(["../fuera.txt"])
    expect(noted.skipped[0].reason).toMatch(/fuera del proyecto/)
    store.close()
  })

  test("directorio: sin @ calla, con @ deja EISDIR", async () => {
    const dir = project()
    mkdirSync(join(dir, "sub"))
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const silent = await autoServeMentionedPaths("revisa sub/", dir, proj)
    expect(silent.served).toEqual([])
    expect(silent.skipped).toEqual([])
    const noted = await autoServeMentionedPaths("revisa @sub/", dir, proj)
    expect(noted.skipped.map((s) => s.file)).toEqual(["sub"])
    expect(noted.skipped[0].reason).toMatch(/directorio/)
    store.close()
  })

  test(".env nunca se auto-sirve, ni con @, y no deja nota", async () => {
    const dir = project()
    writeFileSync(join(dir, ".env"), "TOKEN=1")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const naked = await autoServeMentionedPaths("revisa .env", dir, proj)
    expect(naked.served).toEqual([])
    expect(naked.skipped).toEqual([])
    const explicit = await autoServeMentionedPaths("revisa @.env", dir, proj)
    expect(explicit.served).toEqual([])
    expect(explicit.skipped).toEqual([])
    expect(proj.peek(join(dir, ".env"))).toBeNull()
    store.close()
  })

  test(".ENV y .PEM se reconocen por case-fold y no dejan nota", async () => {
    const dir = project()
    writeFileSync(join(dir, ".ENV"), "TOKEN=1")
    writeFileSync(join(dir, "Secret.PEM"), "KEY")
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const naked = await autoServeMentionedPaths("revisa .ENV y Secret.PEM", dir, proj)
    expect(naked.served).toEqual([])
    expect(naked.skipped).toEqual([])
    const explicit = await autoServeMentionedPaths("revisa @.ENV y @Secret.PEM", dir, proj)
    expect(explicit.served).toEqual([])
    expect(explicit.skipped).toEqual([])
    expect(proj.peek(join(dir, ".ENV"))).toBeNull()
    expect(proj.peek(join(dir, "Secret.PEM"))).toBeNull()
    store.close()
  })

  test.skipIf(!SYMLINKS)("symlink .env → env.txt no se sirve (secreto por el token)", async () => {
    const dir = project()
    writeFileSync(join(dir, "env.txt"), "TOKEN=1")
    symlinkSync(join(dir, "env.txt"), join(dir, ".env"))
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("revisa @.env", dir, proj)
    expect(served).toEqual([])
    expect(skipped).toEqual([])
    expect(proj.peek(join(dir, "env.txt"))).toBeNull()
    store.close()
  })
})

describe("Gate de skips #20", () => {
  test("re-servir lo servido por otra sesión es válido (sidecars por sesión)", async () => {
    const dir = project()
    writeFileSync(join(dir, "ajeno.txt"), "a1\na2")
    // Geometría real: cada sesión abre su PROPIO sidecar (nada compartido).
    const dbOtra = sharedDb("ajeno-otra")
    const otra = createAnchorStore({ sessionId: "s-otra", storePath: dbOtra })
    // Anchor REAL servido en sesión ajena (nunca inventado: "zzzz" daría
    // verde aunque la impl ensanchara served-record como efecto lateral).
    const foreignAnchor = otra.serve("ajeno.txt", "a1\na2").rows[0].anchor
    otra.close()

    const store = createAnchorStore({ sessionId: "s-mia", storePath: sharedDb("ajeno-mia") })
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths("revisa ajeno.txt", dir, proj)
    expect(served.map((s) => s.file)).toEqual(["ajeno.txt"])
    expect(skipped).toEqual([])
    // Sin herencia: el anchor ajeno sigue stale aquí; la sesión ajena queda intacta.
    expect(() => store.resolve("ajeno.txt", foreignAnchor)).toThrow(/E_ANCHOR_STALE/)
    const vuelta = createAnchorStore({ sessionId: "s-otra", storePath: dbOtra })
    expect(vuelta.resolve("ajeno.txt", foreignAnchor)).toEqual({ line: 1, content: "a1" })
    vuelta.close()
    store.close()
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
    const { served, skipped } = await autoServeMentionedPaths("mira @dist/app.min.js", dir, proj)
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
    const { served, skipped } = await autoServeMentionedPaths("mira @big.txt", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["big.txt"])
    expect(skipped[0].reason).toMatch(/excede/)
    expect(proj.peek(join(dir, "big.txt"))).toBeNull()
    store.close()
  })

  test("excluido y cuota llena → motivo excluido (orden del Gate)", async () => {
    const dir = project()
    writeFileSync(join(dir, "clash.min.js"), "x\ny")
    writeFileSync(join(dir, "f1.txt"), "a\nb")
    const store = memStore("s1", { maxAnchors: 2 })
    const proj = withProjectKeys(store, dir)
    proj.serve(join(dir, "f1.txt"), "a\nb")
    const { served, skipped } = await autoServeMentionedPaths("mira @clash.min.js", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["clash.min.js"])
    expect(skipped[0].reason).toMatch(/excluido/i)
    expect(skipped[0].reason).not.toMatch(/cuota/i)
    expect(skipped[0].reason).not.toMatch(/E_[A-Z_]+/)
    expect(proj.peek(join(dir, "clash.min.js"))).toBeNull()
    store.close()
  })

  test("oversize y cuota llena → motivo oversize (orden del Gate)", async () => {
    const dir = project()
    writeFileSync(join(dir, "gordo.txt"), "0123456789\n")
    writeFileSync(join(dir, "f1.txt"), "a\nb")
    const store = memStore("s1", { maxAnchors: 2, maxFileBytes: 8 })
    const proj = withProjectKeys(store, dir)
    proj.serve(join(dir, "f1.txt"), "a\nb")
    const { served, skipped } = await autoServeMentionedPaths("mira @gordo.txt", dir, proj)
    expect(served).toEqual([])
    expect(skipped.map((s) => s.file)).toEqual(["gordo.txt"])
    expect(skipped[0].reason).toMatch(/excede/)
    expect(skipped[0].reason).not.toMatch(/cuota/i)
    expect(skipped[0].reason).not.toMatch(/E_[A-Z_]+/)
    expect(proj.peek(join(dir, "gordo.txt"))).toBeNull()
    store.close()
  })

  test("ningún skip abre served-record: cero E_ nuevos en los motivos", async () => {
    const dir = project()
    writeFileSync(join(dir, "big.txt"), "0123456789\n")
    const store = memStore("s1", { maxFileBytes: 8 })
    const proj = withProjectKeys(store, dir)
    const { skipped } = await autoServeMentionedPaths("mira @../fuera.txt @big.txt", dir, proj)
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
      [{ file: "x.txt", reason: "sin Cuota libre bajo maxAnchors 4096" }],
    )
    expect(note).toMatch(/H_AUTO_READ/)
    expect(note).toContain("x.txt")
    expect(note).toContain("Cuota")
  })

  test("tope de 200 filas inlineadas con aviso de truncado", () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      anchor: "abcd",
      line: i + 1,
      content: `l${i}`,
    }))
    const note = formatAutoReadNote([], [{ file: "big.txt", lines: 250, rows }]) ?? ""
    const shown = note.split("\n").filter((l) => /^[a-z]{4}│/.test(l)).length
    expect(shown).toBe(200)
    expect(note).toContain("… (+50 line(s) not shown)")
  })
})
