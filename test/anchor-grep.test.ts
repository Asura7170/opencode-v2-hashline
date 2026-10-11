import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/

function project() {
  return mkdtempSync(join(tmpdir(), "t14-"))
}

function makeCtx(projectDir: string) {
  const tools = new Map<string, unknown>()
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
      transform: async (cb: (editor: Record<string, (arg: unknown) => unknown>) => void) => {
        const editor = {
          list: () => [...tools.entries()].map(([id, t]) => ({ ...(t as object), id })),
          get: (id: string) => (tools.get(id) ? ({ ...(tools.get(id) as object), id }) : undefined),
          namespace: () => {},
          add: (t: { name: string }) => {
            tools.set(t.name, { ...t })
          },
          update: (id: string, fn: (t: Record<string, unknown>) => void) => {
            const cur = tools.get(id)
            if (!cur) return
            const mut = { ...(cur as object) }
            fn(mut as Record<string, unknown>)
            tools.set(id, mut)
          },
          remove: (id: string) => {
            tools.delete(id)
          },
        }
        cb(editor as unknown as Record<string, (arg: unknown) => unknown>)
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, tools }
}

async function setup(projectDir: string) {
  const { ctx, tools } = makeCtx(projectDir)
  const cleanup = await plugin.setup(ctx as never)
  return { tools: tools as Map<string, { execute: (input: unknown, ctx: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }> }>, cleanup }
}

function callCtx(sessionID = "s1") {
  return {
    sessionID,
    agent: "a",
    messageID: "m",
    id: "c",
    signal: new AbortController().signal,
    progress: async () => {},
  }
}

function rowsOf(text: string): { anchor: string; content: string }[] {
  return text
    .split("\n")
    .filter((l) => ROW_RE.test(l))
    .map((l) => ({ anchor: l.slice(0, 4), content: l.slice(5) }))
}

function tool(
  tools: Map<string, { execute: (input: unknown, ctx: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }> }>,
  name: string,
) {
  const t = tools.get(name)
  if (!t) throw new Error(`tool faltante: ${name}`)
  return t
}

describe("t14 anchor_grep read-only", () => {
  test("devuelve solo los Anchors servidos que coinciden", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "alpha one\nbeta two\nalpha three\ngamma")
    const { tools, cleanup } = await setup(dir)
    const grep = tool(tools, "anchor_grep")
    const served = rowsOf(
      (await tool(tools, "read").execute({ file: "a.txt" }, callCtx())).content,
    )
    const out = await grep.execute({ file: "a.txt", pattern: "alpha" }, callCtx())
    const hits = rowsOf(out.content)
    expect(hits.map((r) => r.content)).toEqual(["alpha one", "alpha three"])
    // Los anchors devueltos son los ya servidos, no nuevos.
    const byContent = new Map(served.map((r) => [r.content, r.anchor]))
    for (const h of hits) expect(byContent.get(h.content)).toBe(h.anchor)
    await cleanup?.()
  })

  test("Served-record intacto tras buscar (mismos anchors, disco sin tocar)", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree")
    const { tools, cleanup } = await setup(dir)
    const before = rowsOf((await tool(tools, "read").execute({ file: "a.txt" }, callCtx())).content)
    await tool(tools, "anchor_grep").execute({ file: "a.txt", pattern: "t" }, callCtx())
    const after = rowsOf((await tool(tools, "read").execute({ file: "a.txt" }, callCtx())).content)
    expect(after.map((r) => r.anchor)).toEqual(before.map((r) => r.anchor))
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("one\ntwo\nthree")
    await cleanup?.()
  })

  test("archivo no servido → nota que manda a read, sin error duro", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "hello world")
    const { tools, cleanup } = await setup(dir)
    const out = await tool(tools, "anchor_grep").execute({ file: "a.txt", pattern: "hello" }, callCtx())
    expect(out.content).toMatch(/read/)
    expect(rowsOf(out.content)).toHaveLength(0)
    // No sirvió nada: el read posterior sirve fresco sin stale.
    const served = await tool(tools, "read").execute({ file: "a.txt" }, callCtx())
    expect(rowsOf(served.content).map((r) => r.content)).toEqual(["hello world"])
    await cleanup?.()
  })

  test("literal: metacaracteres de regex no actúan", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a.c\nabc\naxc")
    const { tools, cleanup } = await setup(dir)
    await tool(tools, "read").execute({ file: "a.txt" }, callCtx())
    const out = await tool(tools, "anchor_grep").execute({ file: "a.txt", pattern: "a.c" }, callCtx())
    expect(rowsOf(out.content).map((r) => r.content)).toEqual(["a.c"])
    await cleanup?.()
  })

  test("cero coincidencias: 0 match(es), sin error", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "one\ntwo")
    const { tools, cleanup } = await setup(dir)
    await tool(tools, "read").execute({ file: "a.txt" }, callCtx())
    const out = await tool(tools, "anchor_grep").execute({ file: "a.txt", pattern: "zzz" }, callCtx())
    expect(out.content).toMatch(/0 match/)
    expect(rowsOf(out.content)).toHaveLength(0)
    expect(out.metadata.totalMatches).toBe(0)
    await cleanup?.()
  })

  test("respeta excludes (E_PATH_EXCLUDED sin servir)", async () => {
    const dir = project()
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(dir, "node_modules"), { recursive: true })
    writeFileSync(join(dir, "node_modules/x.txt"), "secret match\n")
    const { tools, cleanup } = await setup(dir)
    await expect(
      tool(tools, "anchor_grep").execute({ file: "node_modules/x.txt", pattern: "secret" }, callCtx()),
    ).rejects.toThrow(/E_PATH_EXCLUDED/)
    await cleanup?.()
  })

  test("pagina con los mismos topes que read (limit + hint + nextAnchor)", async () => {
    const dir = project()
    writeFileSync(
      join(dir, "a.txt"),
      Array.from({ length: 6 }, (_, i) => `hit ${i}`).join("\n"),
    )
    const { tools, cleanup } = await setup(dir)
    await tool(tools, "read").execute({ file: "a.txt" }, callCtx())
    const out = await tool(tools, "anchor_grep").execute(
      { file: "a.txt", pattern: "hit", limit: 2 },
      callCtx(),
    )
    expect(rowsOf(out.content).map((r) => r.content)).toEqual(["hit 0", "hit 1"])
    expect(out.content).toMatch(/\+4 more/)
    expect(out.metadata.hasMore).toBe(true)
    expect(typeof out.metadata.nextAnchor).toBe("string")
    // Segunda página desde el anchor indicado continúa donde quedó.
    const next = String(out.metadata.nextAnchor)
    const page2 = await tool(tools, "anchor_grep").execute(
      { file: "a.txt", pattern: "hit", offset: next, limit: 2 },
      callCtx(),
    )
    expect(rowsOf(page2.content).map((r) => r.content)).toEqual(["hit 2", "hit 3"])
    await cleanup?.()
  })
})
