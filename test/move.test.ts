import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/

function project() {
  return mkdtempSync(join(tmpdir(), "t15-"))
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

async function move(
  tools: Map<string, any>,
  args: Record<string, unknown>,
  ctx: any,
) {
  return tools.get("move").execute(args, ctx)
}

describe("t15 move destino-primero con vaciado de origen", () => {
  test("traslada líneas: destino gana, origen pierde, verificado en disco", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2\na3")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    const out = await move(
      tools,
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
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a3")
    // Diff con anchors vivos en destino: las trasladadas resuelven al releer.
    const added = out.content.match(/\+ (....)│a1/)
    expect(added).not.toBeNull()
    const after = await anchorsOf(tools, "b.txt", ctx)
    expect(after.map((r) => r.content)).toEqual(["b1", "a1", "a2", "b2"])
    expect(after[1].anchor).toBe(added![1])
    // Sin herencia: las trasladadas estrenan anchors, no los del origen.
    expect(src.map((r) => r.anchor)).not.toContain(after[1].anchor)
    // No tocadas conservan anchor en ambos lados.
    expect(after[0].anchor).toBe(dst[0].anchor)
    expect(after[3].anchor).toBe(dst[1].anchor)
    const srcAfter = await anchorsOf(tools, "a.txt", ctx)
    expect(srcAfter.map((r) => r.content)).toEqual(["a3"])
    expect(srcAfter[0].anchor).toBe(src[2].anchor)
    await cleanup?.()
  })

  test("traslada antes de un anchor", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "x\ny")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    await move(
      tools,
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
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("x")
    await cleanup?.()
  })

  test("mover todo el contenido vacía el origen del todo", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    await move(
      tools,
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
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\na1\na2")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("")
    // El vaciado commitea: hay undo propio del origen.
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2")
    await cleanup?.()
  })

  test("fallo en destino → origen intacto (destino no servido)", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    // b.txt jamás servido: anchor inventado no resuelve.
    await expect(
      move(
        tools,
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
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2")
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\nb2")
    await cleanup?.()
  })

  test("fallo en destino → origen intacto (anchor del origen como destino)", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    await anchorsOf(tools, "b.txt", ctx)
    // Sin herencia de served-record: anchor del origen no vale en destino.
    await expect(
      move(
        tools,
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
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2")
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1")
    await cleanup?.()
  })
})

describe("t15 move: batch y undo por archivo independientes por lado", () => {
  test("solape en destino del mismo mensaje → E_BATCH_OVERLAP", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    await move(
      tools,
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
    const srcMid = await anchorsOf(tools, "a.txt", ctx)
    // Mismo punto de destino sin mensaje nuevo: solapa (origen distinto).
    await expect(
      move(
        tools,
        {
          file: "a.txt",
          startAnchor: srcMid[0].anchor,
          destFile: "b.txt",
          destAnchor: mid[0].anchor,
          position: "after",
        },
        ctx,
      ),
    ).rejects.toThrow(/E_BATCH_OVERLAP/)
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\na1\nb2")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a2")
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
    await move(
      tools,
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
      move(
        tools,
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
    // El primer traslado sigue en pie en ambos lados.
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\na1\na2")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a3")
    await cleanup?.()
  })

  test("undo por archivo: cada lado restaura lo suyo sin undo atómico", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    await move(
      tools,
      {
        file: "a.txt",
        startAnchor: src[0].anchor,
        destFile: "b.txt",
        destAnchor: dst[0].anchor,
        position: "after",
      },
      ctx,
    )
    // Undo del destino: restaura b.txt, el origen sigue vaciado.
    await tools.get("undo_last_change").execute({ file: "b.txt" }, ctx)
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a2")
    // Undo del origen: restaura a.txt, el destino no se toca.
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2")
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1")
    await cleanup?.()
  })

  test("mismo archivo: reordena con un solo undo", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2\na3")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await move(
      tools,
      {
        file: "a.txt",
        startAnchor: before[0].anchor,
        destFile: "a.txt",
        destAnchor: before[2].anchor,
        position: "after",
      },
      ctx,
    )
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a2\na3\na1")
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2\na3")
    await expect(tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)).rejects.toThrow(
      /E_UNDO_EMPTY/,
    )
    await cleanup?.()
  })
})

describe("t15 move y EOL del origen", () => {
  test("vaciar un origen CRLF conserva su EOL", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\r\na2\r\na3\r\n")
    writeFileSync(join(dir, "b.txt"), "b1\n")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", ctx)
    const dst = await anchorsOf(tools, "b.txt", ctx)
    await move(
      tools,
      {
        file: "a.txt",
        startAnchor: src[0].anchor,
        destFile: "b.txt",
        destAnchor: dst[0].anchor,
        position: "after",
      },
      ctx,
    )
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a2\r\na3\r\n")
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\na1\n")
    await cleanup?.()
  })
})
