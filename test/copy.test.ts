import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/

function project() {
  return mkdtempSync(join(tmpdir(), "t13-"))
}

function makeCtx(projectDir: string) {
  const tools = new Map<string, any>()
  const ctx = {
    location: {
      directory: projectDir,
      project: { id: "p1", directory: projectDir, canonical: projectDir },
    },
    options: {},
    session: {
      hook: async () => ({ dispose: async () => {} }),
    },
    tool: {
      transform: async (cb: (editor: any) => void) => {
        const editor = {
          list: () => [...tools.entries()].map(([id, t]) => ({ ...t, id })),
          get: (id: string) => (tools.get(id) ? { ...tools.get(id), id } : undefined),
          namespace: () => {},
          add: (t: any) => {
            tools.set(t.name, { ...t })
          },
          update: (id: string, fn: (t: any) => void) => {
            const cur = tools.get(id)
            if (!cur) return
            const mut = { ...cur }
            fn(mut)
            tools.set(id, mut)
          },
          remove: (id: string) => {
            tools.delete(id)
          },
        }
        cb(editor)
        return { dispose: async () => {} }
      },
    },
  } as any
  return { ctx, tools }
}

async function setup(projectDir: string) {
  const { ctx, tools } = makeCtx(projectDir)
  const cleanup = await plugin.setup(ctx)
  return { tools, cleanup }
}

function callCtx(sessionID = "s1", messageID = "m1") {
  return {
    sessionID,
    agent: "a",
    messageID,
    id: `c-${messageID}`,
    signal: new AbortController().signal,
    progress: async () => {},
  } as any
}

function rowsOf(text: string): { anchor: string; content: string }[] {
  return text
    .split("\n")
    .filter((l) => ROW_RE.test(l))
    .map((l) => ({ anchor: l.slice(0, 4), content: l.slice(5) }))
}

async function anchorsOf(tools: Map<string, any>, file: string, ctx: any) {
  const out = await tools.get("read").execute({ file }, ctx)
  return rowsOf(out.content)
}

describe("t13 copy a destino servido", () => {
  test("replica líneas tras un anchor verificada en disco", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2\na3")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    const out = await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: src[0].anchor,
          endAnchor: src[1].anchor,
          destFile: "b.txt",
          destAnchor: dst[0].anchor,
          position: "after",
        },
        ctx,
      )
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\na1\na2\nb2")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2\na3")
    // Diff con anchors vivos: las copiadas resuelven en la re-lectura.
    const added = out.content.match(/\+ (....)│a1/)
    expect(added).not.toBeNull()
    const after = await anchorsOf(tools, "b.txt", ctx)
    expect(after.map((r) => r.content)).toEqual(["b1", "a1", "a2", "b2"])
    expect(after[1].anchor).toBe(added![1])
    // No tocadas conservan anchor.
    expect(after[0].anchor).toBe(dst[0].anchor)
    expect(after[3].anchor).toBe(dst[1].anchor)
    await cleanup?.()
  })

  test("replica antes de un anchor", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "x\ny")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: src[1].anchor,
          destFile: "b.txt",
          destAnchor: dst[1].anchor,
          position: "before",
        },
        ctx,
      )
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\ny\nb2")
    await cleanup?.()
  })

  test("destino no servido → E_ANCHOR_STALE sin escritura", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    // b.txt jamás servido: anchor inventado no resuelve.
    await expect(
      tools
        .get("copy")
        .execute(
          {
            file: "a.txt",
            startAnchor: src[0].anchor,
            destFile: "b.txt",
            destAnchor: "zzzz",
            position: "after",
          },
          ctx,
        ),
    ).rejects.toThrow(/E_ANCHOR_STALE/)
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\nb2")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2")
    await cleanup?.()
  })

  test("destino servido en otra sesión → E_ANCHOR_STALE sin auto-servir (US7)", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)
    const ctxS1 = callCtx("s1", "m1")
    const ctxS2 = callCtx("s2", "m1")
    const src = await anchorsOf(tools, "a.txt", ctxS1)
    const dstS2 = await anchorsOf(tools, "b.txt", ctxS2)
    // Anchor real pero de otra sesión: en s1 el destino sigue no servido.
    await expect(
      tools
        .get("copy")
        .execute(
          {
            file: "a.txt",
            startAnchor: src[0].anchor,
            destFile: "b.txt",
            destAnchor: dstS2[0].anchor,
            position: "after",
          },
          ctxS1,
        ),
    ).rejects.toThrow(/E_ANCHOR_STALE/)
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\nb2")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2")
    // Sin efecto lateral: el fallo no sirvió b.txt en s1.
    const grep = await tools.get("anchor_grep").execute({ file: "b.txt", pattern: "b1" }, ctxS1)
    expect(grep.metadata.served).toBe(false)
    await cleanup?.()
  })

  test("no hereda served-record del origen", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    await anchorsOf(tools, "b.txt", ctx)
    // Anchor válido del origen usado como destino: stale, sin escritura.
    await expect(
      tools
        .get("copy")
        .execute(
          {
            file: "a.txt",
            startAnchor: src[0].anchor,
            destFile: "b.txt",
            destAnchor: src[1].anchor,
            position: "after",
          },
          ctx,
        ),
    ).rejects.toThrow(/E_ANCHOR_STALE/)
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1")
    // Réplica real: las copiadas estrenan anchors, no los del origen.
    const dst = await anchorsOf(tools, "b.txt", ctx)
    await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: src[0].anchor,
          destFile: "b.txt",
          destAnchor: dst[0].anchor,
          position: "after",
        },
        ctx,
      )
    const after = await anchorsOf(tools, "b.txt", ctx)
    const copied = after.find((r) => r.content === "a1")!
    expect(src.map((r) => r.anchor)).not.toContain(copied.anchor)
    await cleanup?.()
  })
})

describe("t13 copy: batch y undo por archivo independientes por lado", () => {
  test("solape en destino del mismo mensaje → E_BATCH_OVERLAP", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: src[0].anchor,
          destFile: "b.txt",
          destAnchor: dst[0].anchor,
          position: "after",
        },
        ctx,
      )
    const mid = await anchorsOf(tools, "b.txt", ctx)
    // Mismo punto de destino sin mensaje nuevo: solapa.
    await expect(
      tools
        .get("copy")
        .execute(
          {
            file: "a.txt",
            startAnchor: src[1].anchor,
            destFile: "b.txt",
            destAnchor: mid[0].anchor,
            position: "after",
          },
          ctx,
        ),
    ).rejects.toThrow(/E_BATCH_OVERLAP/)
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\na1\nb2")
    await cleanup?.()
  })

  test("solape en origen del mismo mensaje → E_BATCH_OVERLAP", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2\na3")
    writeFileSync(join(dir, "b.txt"), "b1")
    writeFileSync(join(dir, "c.txt"), "c1")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dstB = await anchorsOf(tools, "b.txt", ctx)
    await anchorsOf(tools, "c.txt", ctx)
    await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: src[0].anchor,
          endAnchor: src[1].anchor,
          destFile: "b.txt",
          destAnchor: dstB[0].anchor,
          position: "after",
        },
        ctx,
      )
    const dstC = await anchorsOf(tools, "c.txt", ctx)
    // Mismo rango de origen a otro destino en el mismo mensaje: solapa.
    await expect(
      tools
        .get("copy")
        .execute(
          {
            file: "a.txt",
            startAnchor: src[0].anchor,
            endAnchor: src[1].anchor,
            destFile: "c.txt",
            destAnchor: dstC[0].anchor,
            position: "after",
          },
          ctx,
        ),
    ).rejects.toThrow(/E_BATCH_OVERLAP/)
    expect(await readFile(join(dir, "c.txt"), "utf-8")).toBe("c1")
    await cleanup?.()
  })

  test("undo por archivo: destino restaura, origen no tiene nada", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: src[0].anchor,
          destFile: "b.txt",
          destAnchor: dst[0].anchor,
          position: "after",
        },
        ctx,
      )
    await tools.get("undo_last_change").execute({ file: "b.txt" }, ctx)
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2")
    // El origen nunca commiteó: sin undo propio.
    await expect(tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)).rejects.toThrow(
      /E_UNDO_EMPTY/,
    )
    await cleanup?.()
  })

  test("mensajes distintos en destino = undos separados", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1")
    const { tools, cleanup } = await setup(dir)
    const src = await anchorsOf(tools, "a.txt", callCtx("s1", "m1"))
    const d1 = await anchorsOf(tools, "b.txt", callCtx("s1", "m1"))
    await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: src[0].anchor,
          destFile: "b.txt",
          destAnchor: d1[0].anchor,
          position: "after",
        },
        callCtx("s1", "m1"),
      )
    const d2 = await anchorsOf(tools, "b.txt", callCtx("s1", "m2"))
    await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: src[1].anchor,
          destFile: "b.txt",
          destAnchor: d2[1].anchor,
          position: "after",
        },
        callCtx("s1", "m2"),
      )
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\na1\na2")
    await tools.get("undo_last_change").execute({ file: "b.txt" }, callCtx("s1", "m3"))
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\na1")
    await expect(
      tools.get("undo_last_change").execute({ file: "b.txt" }, callCtx("s1", "m4")),
    ).rejects.toThrow(/E_UNDO_EMPTY/)
    await cleanup?.()
  })

  test("mismo archivo: duplica sin mezclar y comparte un batch", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: before[0].anchor,
          destFile: "a.txt",
          destAnchor: before[0].anchor,
          position: "after",
        },
        ctx,
      )
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na1\na2")
    // Un solo batch compartido: el undo cubre la copia de una vez.
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2")
    await cleanup?.()
  })
})
