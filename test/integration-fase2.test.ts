import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/

function project() {
  return mkdtempSync(join(tmpdir(), "t17-"))
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

describe("t17 flujo combinado fase 2", () => {
  test("serve → replace_match → copy → move → grep → undo", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2\na3")
    writeFileSync(join(dir, "b.txt"), "b1\nb2")
    const { tools, cleanup } = await setup(dir)

    // m1: servir ambos.
    const m1 = callCtx("s1", "m1")
    const src = await anchorsOf(tools, "a.txt", m1)
    const dst = await anchorsOf(tools, "b.txt", m1)
    expect(src.map((r) => r.content)).toEqual(["a1", "a2", "a3"])
    expect(dst.map((r) => r.content)).toEqual(["b1", "b2"])

    // m2: replace_match literal en a.txt.
    const m2 = callCtx("s1", "m2")
    await tools.get("replace_match").execute({ file: "a.txt", match: "a1", content: "A1" }, m2)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A1\na2\na3")

    // m3: copy A1,a2 de a.txt a b.txt tras b1.
    const m3 = callCtx("s1", "m3")
    const src3 = await anchorsOf(tools, "a.txt", m3)
    const dst3 = await anchorsOf(tools, "b.txt", m3)
    await tools
      .get("copy")
      .execute(
        {
          file: "a.txt",
          startAnchor: src3[0].anchor,
          endAnchor: src3[1].anchor,
          destFile: "b.txt",
          destAnchor: dst3[0].anchor,
          position: "after",
        },
        m3,
      )
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\nA1\na2\nb2")
    const snapA = await readFile(join(dir, "a.txt"), "utf-8")
    const snapB = await readFile(join(dir, "b.txt"), "utf-8")

    // m4: move de la línea A1 desde b.txt al final de a.txt.
    const m4 = callCtx("s1", "m4")
    const srcB = await anchorsOf(tools, "b.txt", m4)
    const dstA = await anchorsOf(tools, "a.txt", m4)
    const moved = srcB.find((r) => r.content === "A1")
    expect(moved).toBeDefined()
    await tools
      .get("move")
      .execute(
        {
          file: "b.txt",
          startAnchor: moved!.anchor,
          destFile: "a.txt",
          destAnchor: dstA[dstA.length - 1].anchor,
          position: "after",
        },
        m4,
      )
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("b1\na2\nb2")
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A1\na2\na3\nA1")

    // m5: grep localiza A1 en a.txt sin servir nada nuevo.
    const m5 = callCtx("s1", "m5")
    const before = await anchorsOf(tools, "a.txt", m5)
    const grepOut = await tools.get("anchor_grep").execute({ file: "a.txt", pattern: "A1" }, m5)
    expect(grepOut.content).toMatch(/│A1/)
    const after = await anchorsOf(tools, "a.txt", m5)
    expect(after.map((r) => r.anchor)).toEqual(before.map((r) => r.anchor))

    // m6: undo por archivo restaura el estado post-m3 en ambos lados.
    const m6 = callCtx("s1", "m6")
    await tools.get("undo_last_change").execute({ file: "a.txt" }, m6)
    await tools.get("undo_last_change").execute({ file: "b.txt" }, m6)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe(snapA)
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe(snapB)
    await cleanup?.()
  })
})
