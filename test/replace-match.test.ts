import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/

function project() {
  return mkdtempSync(join(tmpdir(), "t12-"))
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

describe("t12 replace_match por Match literal", () => {
  test("sustituye una ocurrencia servida, verificada en disco", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "hello foo world\nsecond line")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    await tools.get("read").execute({ file: "a.txt" }, ctx)
    const out = await tools
      .get("replace_match")
      .execute({ file: "a.txt", match: "foo", content: "BAR" }, ctx)
    expect(out.metadata.changed).toBe(true)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("hello BAR world\nsecond line")
    const after = rowsOf((await tools.get("read").execute({ file: "a.txt" }, ctx)).content)
    expect(after.map((r) => r.content)).toEqual(["hello BAR world", "second line"])
    await cleanup?.()
  })

  test("case-sensitive: distinto case no cuenta como ocurrencia", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "Foo bar")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    await tools.get("read").execute({ file: "a.txt" }, ctx)
    await expect(
      tools.get("replace_match").execute({ file: "a.txt", match: "foo", content: "x" }, ctx),
    ).rejects.toThrow(/E_ANCHOR_MATCH/)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("Foo bar")
    await cleanup?.()
  })

  test("cero ocurrencias → E_ANCHOR_MATCH, sin escritura", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    await tools.get("read").execute({ file: "a.txt" }, ctx)
    await expect(
      tools.get("replace_match").execute({ file: "a.txt", match: "zzz", content: "X" }, ctx),
    ).rejects.toThrow(/E_ANCHOR_MATCH/)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nb\nc")
    await cleanup?.()
  })

  test("más de una ocurrencia → E_ANCHOR_MATCH, sin escritura", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a foo b foo c")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    await tools.get("read").execute({ file: "a.txt" }, ctx)
    await expect(
      tools.get("replace_match").execute({ file: "a.txt", match: "foo", content: "X" }, ctx),
    ).rejects.toThrow(/E_ANCHOR_MATCH/)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a foo b foo c")
    await cleanup?.()
  })

  test("overlap con replace del mismo mensaje → E_BATCH_OVERLAP, sin commit parcial", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc\nd")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[0].anchor, endAnchor: before[1].anchor, content: "A\nB" },
        ctx,
      )
    await expect(
      tools.get("replace_match").execute({ file: "a.txt", match: "B\nc", content: "X" }, ctx),
    ).rejects.toThrow(/E_BATCH_OVERLAP/)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nB\nc\nd")
    // Rango disjunto sí aplica dentro del mismo batch.
    await tools.get("replace_match").execute({ file: "a.txt", match: "d", content: "D" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nB\nc\nD")
    await cleanup?.()
  })

  test("replace tras replace_match sobre la zona tocada → E_BATCH_OVERLAP", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    await anchorsOf(tools, "a.txt", ctx)
    await tools.get("replace_match").execute({ file: "a.txt", match: "b", content: "B" }, ctx)
    const mid = await anchorsOf(tools, "a.txt", ctx)
    await expect(
      tools
        .get("replace")
        .execute(
          { file: "a.txt", startAnchor: mid[1].anchor, endAnchor: mid[1].anchor, content: "X" },
          ctx,
        ),
    ).rejects.toThrow(/E_BATCH_OVERLAP/)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nB\nc")
    await cleanup?.()
  })

  test("comparte un undo con replace del mismo mensaje", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[0].anchor, endAnchor: before[0].anchor, content: "A" },
        ctx,
      )
    await tools.get("replace_match").execute({ file: "a.txt", match: "b", content: "B" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nB")
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nb")
    await cleanup?.()
  })

  test("reemplazo idéntico no escribe (H_NOOP, mtime intacto)", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "foo\nbar")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    await tools.get("read").execute({ file: "a.txt" }, ctx)
    const m1 = (await stat(join(dir, "a.txt"))).mtimeMs
    await Bun.sleep(25)
    const out = await tools
      .get("replace_match")
      .execute({ file: "a.txt", match: "foo", content: "foo" }, ctx)
    expect(out.content).toMatch(/H_NOOP/)
    expect(out.metadata.changed).toBe(false)
    expect((await stat(join(dir, "a.txt"))).mtimeMs).toBe(m1)
    await cleanup?.()
  })

  test("registrada directa al provider (codemode false)", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "one")
    const { tools, cleanup } = await setup(dir)
    expect(tools.get("replace_match")?.options).toEqual({ codemode: false })
    await cleanup?.()
  })
})
