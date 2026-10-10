import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/

function project() {
  return mkdtempSync(join(tmpdir(), "t5-"))
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

function callCtx(sessionID = "s1") {
  return {
    sessionID: "s1",
    agent: "a",
    messageID: "m",
    id: "c",
    signal: new AbortController().signal,
    progress: async () => {},
    ...(sessionID !== "s1" ? { sessionID } : {}),
  } as any
}

function rowsOf(text: string): { anchor: string; content: string }[] {
  return text
    .split("\n")
    .filter((l) => ROW_RE.test(l))
    .map((l) => {
      const anchor = l.slice(0, 4)
      const content = l.slice(5)
      return { anchor, content }
    })
}

function rowContents(text: string): string[] {
  return rowsOf(text).map((r) => r.content)
}

describe("t5 read (override nativo)", () => {
  test("sirve filas anchor│content", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree")
    const { tools, cleanup } = await setup(dir)
    const read = tools.get("read")
    expect(read).toBeDefined()
    const out = await read.execute({ file: "a.txt" }, callCtx())
    expect(rowContents(out.content)).toEqual(["one", "two", "three"])
    expect(rowsOf(out.content)).toHaveLength(3)
    await cleanup?.()
  })

  test("override: reemplaza el read nativo previo", async () => {
    const dir = project()
    writeFileSync(join(dir, "real.txt"), "hi")
    const { ctx, tools } = makeCtx(dir)
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "read",
        description: "native",
        input: { type: "object", properties: {} },
        execute: async () => ({ content: "native" }),
      })
    })
    await plugin.setup(ctx)
    const out = await tools.get("read").execute({ file: "real.txt" }, callCtx())
    expect(out.content).not.toContain("native")
    expect(out.content).toMatch(ROW_RE)
    expect(tools.get("read").description).toMatch(/anchor/i)
  })

  test("pagina por línea con hint de continuación", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "l1\nl2\nl3\nl4\nl5")
    const { tools, cleanup } = await setup(dir)
    const out = await tools.get("read").execute({ file: "a.txt", offset: 2, limit: 2 }, callCtx())
    expect(rowContents(out.content)).toEqual(["l2", "l3"])
    expect(out.content).toMatch(/\+2 more/)
    expect(out.metadata.hasMore).toBe(true)
    await cleanup?.()
  })

  test("pagina por anchor", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "l1\nl2\nl3\nl4")
    const { tools, cleanup } = await setup(dir)
    const first = await tools.get("read").execute({ file: "a.txt" }, callCtx())
    const anchor3 = rowsOf(first.content)[2].anchor
    const page = await tools.get("read").execute(
      { file: "a.txt", offset: anchor3, limit: 2 },
      callCtx(),
    )
    expect(rowContents(page.content)).toEqual(["l3", "l4"])
    await cleanup?.()
  })

  test("missing file → E_FILE_NOT_FOUND", async () => {
    const dir = project()
    const { tools, cleanup } = await setup(dir)
    await expect(
      tools.get("read").execute({ file: "nope.txt" }, callCtx()),
    ).rejects.toThrow(/E_FILE_NOT_FOUND/)
    await cleanup?.()
  })
})

describe("t5 replace por anchor", () => {
  test("reemplaza rango y muestra diff con anchors vivos", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc")
    const { tools, cleanup } = await setup(dir)
    const before = rowsOf((await tools.get("read").execute({ file: "a.txt" }, callCtx())).content)
    const out = await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[1].anchor, endAnchor: before[1].anchor, content: "B2" },
        callCtx(),
      )
    expect(out.content).toMatch(/\+ ....│B2/)
    const after = rowsOf((await tools.get("read").execute({ file: "a.txt" }, callCtx())).content)
    expect(after.map((r) => r.content)).toEqual(["a", "B2", "c"])
    // no tocadas conservan anchor
    expect(after[0].anchor).toBe(before[0].anchor)
    expect(after[2].anchor).toBe(before[2].anchor)
    // diff trae anchors vivos: el nuevo anchor resuelve en la re-lectura
    const diffAnchor = out.content.match(/\+ (....)│B2/)![1]
    expect(after[1].anchor).toBe(diffAnchor)
    await cleanup?.()
  })

  test("stale → E_ANCHOR_STALE con filas actuales", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb")
    const { tools, cleanup } = await setup(dir)
    await tools.get("read").execute({ file: "a.txt" }, callCtx())
    try {
      await tools
        .get("replace")
        .execute({ file: "a.txt", startAnchor: "zzzz", endAnchor: "zzzz", content: "x" }, callCtx())
      expect.unreachable()
    } catch (err: any) {
      expect(String(err)).toMatch(/E_ANCHOR_STALE/)
      expect(err.rows?.map((r: any) => r.content) ?? String(err)).toEqual(["a", "b"])
    }
    await cleanup?.()
  })

  test("noop idéntico no escribe (H_NOOP, mtime intacto)", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc")
    const { tools, cleanup } = await setup(dir)
    const before = rowsOf((await tools.get("read").execute({ file: "a.txt" }, callCtx())).content)
    const m1 = (await stat(join(dir, "a.txt"))).mtimeMs
    await Bun.sleep(25)
    const out = await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[0].anchor, endAnchor: before[2].anchor, content: "a\nb\nc" },
        callCtx(),
      )
    expect(out.content).toMatch(/H_NOOP/)
    expect(out.metadata.changed).toBe(false)
    const m2 = (await stat(join(dir, "a.txt"))).mtimeMs
    expect(m2).toBe(m1)
    const after = rowsOf((await tools.get("read").execute({ file: "a.txt" }, callCtx())).content)
    expect(after.map((r) => r.anchor)).toEqual(before.map((r) => r.anchor))
    await cleanup?.()
  })
})

describe("t5 insert por anchor", () => {
  test("inserta después con diff vivo", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nc")
    const { tools, cleanup } = await setup(dir)
    const before = rowsOf((await tools.get("read").execute({ file: "a.txt" }, callCtx())).content)
    const out = await tools
      .get("insert")
      .execute({ file: "a.txt", anchor: before[0].anchor, position: "after", content: "b" }, callCtx())
    expect(out.content).toMatch(/\+ ....│b/)
    const after = rowsOf((await tools.get("read").execute({ file: "a.txt" }, callCtx())).content)
    expect(after.map((r) => r.content)).toEqual(["a", "b", "c"])
    expect(after[0].anchor).toBe(before[0].anchor)
    expect(after[2].anchor).toBe(before[1].anchor)
    await cleanup?.()
  })

  test("inserta antes", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nc")
    const { tools, cleanup } = await setup(dir)
    const before = rowsOf((await tools.get("read").execute({ file: "a.txt" }, callCtx())).content)
    await tools
      .get("insert")
      .execute({ file: "a.txt", anchor: before[1].anchor, position: "before", content: "b" }, callCtx())
    const after = rowsOf((await tools.get("read").execute({ file: "a.txt" }, callCtx())).content)
    expect(after.map((r) => r.content)).toEqual(["a", "b", "c"])
    await cleanup?.()
  })

  test("anchor malo → stale con filas", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb")
    const { tools, cleanup } = await setup(dir)
    await tools.get("read").execute({ file: "a.txt" }, callCtx())
    await expect(
      tools.get("insert").execute({ file: "a.txt", anchor: "zzzz", position: "after", content: "x" }, callCtx()),
    ).rejects.toThrow(/E_ANCHOR_STALE/)
    await cleanup?.()
  })
})

describe("t5 vacías, límites y sidecar", () => {
  test("vacía servible: read da 1 fila anchor│ y permite insert", async () => {
    const dir = project()
    writeFileSync(join(dir, "empty.txt"), "")
    const { tools, cleanup } = await setup(dir)
    const out = await tools.get("read").execute({ file: "empty.txt" }, callCtx())
    const rows = rowsOf(out.content)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe("")
    await tools
      .get("insert")
      .execute({ file: "empty.txt", anchor: rows[0].anchor, position: "after", content: "hi" }, callCtx())
    const after = rowsOf((await tools.get("read").execute({ file: "empty.txt" }, callCtx())).content)
    expect(after.map((r) => r.content)).toEqual(["", "hi"])
    await cleanup?.()
  })

  test("límite inline 2000 líneas con hint", async () => {
    const dir = project()
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n"))
    const { tools, cleanup } = await setup(dir)
    const out = await tools.get("read").execute({ file: "big.txt" }, callCtx())
    expect(rowsOf(out.content)).toHaveLength(2000)
    expect(out.content).toMatch(/\+500 more/)
    expect(out.metadata.hasMore).toBe(true)
    await cleanup?.()
  })

  test("fila larga marcada sin corromper el archivo", async () => {
    const dir = project()
    writeFileSync(join(dir, "long.txt"), `ok\n${"x".repeat(3000)}`)
    const { tools, cleanup } = await setup(dir)
    const out = await tools.get("read").execute({ file: "long.txt" }, callCtx())
    expect(out.content).toMatch(/chars/)
    const after = rowsOf((await tools.get("read").execute({ file: "long.txt", limit: 2 }, callCtx())).content)
    expect(after[1].content.length).toBeGreaterThan(2000)
    await cleanup?.()
  })

  test("sidecar por proyecto+sesión bajo .opencode/hashline", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a")
    const { tools, cleanup } = await setup(dir)
    await tools.get("read").execute({ file: "a.txt" }, callCtx("sess-1"))
    await tools.get("read").execute({ file: "a.txt" }, callCtx("sess-2"))
    const { readdirSync } = await import("node:fs")
    const names = readdirSync(join(dir, ".opencode", "hashline")).sort()
    expect(names).toEqual(["sess-1.sqlite", "sess-2.sqlite"])
    await cleanup?.()
  })
})
