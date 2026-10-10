import { describe, expect, test } from "bun:test"

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAnchorStore } from "../src/anchor-store"

function memStore() {
  return createAnchorStore({ sessionId: "s1", storePath: ":memory:" })
}

function tmpDb(name: string) {
  return join(mkdtempSync(join(tmpdir(), "t3-")), `${name}.sqlite`)
}

describe("anchor allocation", () => {
  test("cada línea recibe un anchor único de 4 letras", () => {
    const store = memStore()
    const { rows } = store.serve("a.ts", "one\ntwo\nthree")
    expect(rows).toHaveLength(3)
    for (const [i, row] of rows.entries()) {
      expect(row.anchor).toMatch(/^[a-z]{4}$/)
      expect(row.line).toBe(i + 1)
    }
    expect(new Set(rows.map((r) => r.anchor)).size).toBe(3)
    expect(rows.map((r) => r.content)).toEqual(["one", "two", "three"])
    store.close()
  })

  test("líneas byte-idénticas no comparten anchor", () => {
    const store = memStore()
    const { rows } = store.serve("a.ts", "same\nsame\nsame")
    expect(new Set(rows.map((r) => r.anchor)).size).toBe(3)
    store.close()
  })

  test("anchors no derivan del contenido", () => {
    const a = memStore()
    const b = memStore()
    const ra = a.serve("a.ts", "hello\nworld").rows.map((r) => r.anchor)
    const rb = b.serve("a.ts", "hello\nworld").rows.map((r) => r.anchor)
    expect(ra).not.toEqual(rb)
    a.close()
    b.close()
  })

  test("líneas vacías también reciben anchor servible", () => {
    const store = memStore()
    const { rows } = store.serve("a.ts", "a\n\nb")
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.anchor)).size).toBe(3)
    store.close()
  })
})

describe("anchor stability", () => {
  test("re-serve idéntico conserva anchors sin churn", () => {
    const store = memStore()
    const first = store.serve("a.ts", "a\nb\nc").rows.map((r) => r.anchor)
    const second = store.serve("a.ts", "a\nb\nc").rows.map((r) => r.anchor)
    expect(second).toEqual(first)
    store.close()
  })

  test("commit con inserción conserva anchors de no tocadas", () => {
    const store = memStore()
    const before = Object.fromEntries(
      store.serve("a.ts", "a\nb\nc").rows.map((r) => [r.content, r.anchor]),
    )
    const after = store.commit("a.ts", "a\nX\nb\nc").rows
    expect(after).toHaveLength(4)
    const byContent = Object.fromEntries(after.map((r) => [r.content, r.anchor]))
    expect(byContent["a"]).toBe(before["a"])
    expect(byContent["b"]).toBe(before["b"])
    expect(byContent["c"]).toBe(before["c"])
    store.close()
  })

  test("commit con reemplazo rota solo las tocadas", () => {
    const store = memStore()
    const before = Object.fromEntries(
      store.serve("a.ts", "a\nb\nc").rows.map((r) => [r.content, r.anchor]),
    )
    const after = store.commit("a.ts", "a\nB2\nc").rows
    const byContent = Object.fromEntries(after.map((r) => [r.content, r.anchor]))
    expect(byContent["a"]).toBe(before["a"])
    expect(byContent["c"]).toBe(before["c"])
    expect(byContent["B2"]).not.toBe(before["b"])
    store.close()
  })
})

describe("rechazos", () => {  test("binarios se rechazan con error explícito", () => {
    const store = memStore()
    expect(() => store.serve("a.bin", "ab\0cd")).toThrow(/E_FILE_BINARY/)
    store.close()
  })

  test("oversize (>1MiB) se rechaza con error explícito", () => {
    const store = memStore()
    expect(() => store.serve("big.ts", "x".repeat(1_048_577))).toThrow(/E_FILE_OVERSIZE/)
    store.close()
  })

  test("paths excluidos (v1) se rechazan", () => {
    const store = memStore()
    expect(() => store.serve("node_modules/foo/bar.ts", "a\nb")).toThrow(/E_PATH_EXCLUDED/)
    expect(() => store.serve("dist/app.min.js", "a\nb")).toThrow(/E_PATH_EXCLUDED/)
    store.close()
  })

  test("imágenes no-adjuntables se rechazan", () => {
    const store = memStore()
    expect(() => store.serve("assets/logo.png", "fakepng")).toThrow(/E_FILE_BINARY/)
    store.close()
  })
})

describe("served-record y bordes", () => {
  test("resolve mapea anchor servido a línea actual", () => {
    const store = memStore()
    const { rows } = store.serve("a.ts", "a\nb\nc")
    expect(store.resolve("a.ts", rows[1].anchor)).toEqual({ line: 2, content: "b" })
    store.close()
  })

  test("resolve sigue al anchor tras inserción arriba", () => {
    const store = memStore()
    const { rows } = store.serve("a.ts", "a\nb")
    const target = rows[1].anchor
    store.commit("a.ts", "X\na\nb")
    expect(store.resolve("a.ts", target)).toEqual({ line: 3, content: "b" })
    store.close()
  })

  test("anchor desconocido falla stale con las filas actuales", () => {
    const store = memStore()
    store.serve("a.ts", "a\nb")
    try {
      store.resolve("a.ts", "zzzz")
      expect.unreachable()
    } catch (err: any) {
      expect(String(err)).toMatch(/E_ANCHOR_STALE/)
      expect(err.rows.map((r: any) => r.content)).toEqual(["a", "b"])
    }
    store.close()
  })

  test("anchor de otro archivo no resuelve (stale)", () => {
    const store = memStore()
    const { rows } = store.serve("a.ts", "a\nb")
    store.serve("b.ts", "x\ny")
    expect(() => store.resolve("b.ts", rows[0].anchor)).toThrow(/E_ANCHOR_STALE/)
    store.close()
  })

  test("resolveRange verifica ambos bordes", () => {
    const store = memStore()
    const { rows } = store.serve("a.ts", "a\nb\nc")
    expect(store.resolveRange("a.ts", rows[0].anchor, rows[2].anchor)).toEqual({
      startLine: 1,
      endLine: 3,
    })
    expect(() => store.resolveRange("a.ts", rows[2].anchor, rows[0].anchor)).toThrow(
      /E_ANCHOR_RANGE/,
    )
    try {
      store.resolveRange("a.ts", rows[0].anchor, "zzzz")
      expect.unreachable()
    } catch (err: any) {
      expect(String(err)).toMatch(/E_ANCHOR_STALE/)
      expect(err.rows).toHaveLength(3)
    }
    store.close()
  })
})

describe("ownership y persistencia", () => {
  test("re-serve en otra sesión transfiere ownership", () => {
    const db = tmpDb("transfer")
    const a = createAnchorStore({ sessionId: "sa", storePath: db })
    a.serve("a.ts", "a\nb")
    a.close()
    const b = createAnchorStore({ sessionId: "sb", storePath: db })
    const rows = b.serve("a.ts", "a\nb").rows
    expect(b.resolve("a.ts", rows[0].anchor)).toEqual({ line: 1, content: "a" })
    b.close()
  })

  test("otra sesión no resuelve anchors ajenos", () => {
    const db = tmpDb("shared")
    const a = createAnchorStore({ sessionId: "sa", storePath: db })
    const { rows } = a.serve("a.ts", "a\nb")
    a.close()
    const b = createAnchorStore({ sessionId: "sb", storePath: db })
    expect(() => b.resolve("a.ts", rows[0].anchor)).toThrow(/E_ANCHOR_STALE/)
    b.close()
  })

  test("anchors, served y undo-shadow sobreviven restarts", () => {
    const db = tmpDb("restart")
    const first = createAnchorStore({ sessionId: "s1", storePath: db })
    const before = Object.fromEntries(
      first.serve("a.ts", "a\nb\nc").rows.map((r) => [r.content, r.anchor]),
    )
    first.commit("a.ts", "a\nB2\nc")
    first.close()
    const second = createAnchorStore({ sessionId: "s1", storePath: db })
    expect(second.resolve("a.ts", before["a"])).toEqual({ line: 1, content: "a" })
    expect(second.resolve("a.ts", before["c"])).toEqual({ line: 3, content: "c" })
    expect(second.undoShadow("a.ts")).toEqual(["a", "b", "c"])
    expect(() => second.resolve("a.ts", before["b"])).toThrow(/E_ANCHOR_STALE/)
    second.close()
  })
})

describe("cuota LRU", () => {
  function tinyStore() {
    return createAnchorStore({ sessionId: "s1", storePath: ":memory:", maxAnchors: 4 })
  }

  test("sin presión no hay warnings", () => {
    const store = tinyStore()
    const { warnings } = store.serve("f1.ts", "a\nb")
    expect(warnings).toEqual([])
    store.close()
  })

  test("cuota agotada reclama el LRU con aviso visible", () => {
    const store = tinyStore()
    const f1 = store.serve("f1.ts", "a\nb").rows
    store.serve("f2.ts", "c\nd")
    const { warnings } = store.serve("f3.ts", "e\nf")
    expect(warnings.length).toBe(1)
    expect(warnings[0].code).toBe("W_ANCHOR_QUOTA_RECLAIM")
    expect(warnings[0].message).toMatch(/f1\.ts/)
    expect(() => store.resolve("f1.ts", f1[0].anchor)).toThrow(/E_ANCHOR_STALE/)
    store.close()
  })

  test("el acceso reciente protege del reclamo", () => {
    const store = tinyStore()
    const f1 = store.serve("f1.ts", "a\nb").rows
    const f2 = store.serve("f2.ts", "c\nd").rows
    store.resolve("f1.ts", f1[0].anchor) // f1 pasa a ser MRU
    const { warnings } = store.serve("f3.ts", "e\nf")
    expect(warnings[0].message).toMatch(/f2\.ts/)
    expect(store.resolve("f1.ts", f1[1].anchor)).toEqual({ line: 2, content: "b" })
    expect(() => store.resolve("f2.ts", f2[0].anchor)).toThrow(/E_ANCHOR_STALE/)
    store.close()
  })
})
