import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/

function makeCtx(projectDir: string, options: Record<string, unknown> = {}) {
  const tools = new Map<string, any>()
  const hooks = new Map<string, (input: any) => Promise<void> | void>()
  const ctx = {
    location: {
      directory: projectDir,
      project: { id: "t9-proj", directory: projectDir, canonical: projectDir },
    },
    options,
    session: {
      hook: async (name: string, cb: (input: any) => Promise<void> | void) => {
        hooks.set(name, cb)
        return { dispose: async () => {} }
      },
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
  return { ctx, tools, hooks }
}

function callCtx(sessionID = "s1") {
  return {
    sessionID,
    agent: "a",
    messageID: "m",
    id: "c",
    signal: new AbortController().signal,
    progress: async () => {},
  } as any
}

// Costura: opciones del plugin cableadas a límites y conducta de los tools.
describe("t9 opciones cableadas a los tools", () => {
  test("maxOutputLines por opciones pagina el read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-opt-"))
    writeFileSync(join(dir, "a.txt"), "l1\nl2\nl3\nl4\nl5")
    const { ctx, tools } = makeCtx(dir, { maxOutputLines: 2 })
    const cleanup = await plugin.setup(ctx)
    const out = await tools.get("read").execute({ file: "a.txt" }, callCtx())
    expect(out.content.split("\n").filter((l: string) => ROW_RE.test(l))).toHaveLength(2)
    expect(out.content).toMatch(/\+3 more/)
    await cleanup?.()
  })

  test("archivo de proyecto hace override (sin opciones)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-proj-"))
    writeFileSync(join(dir, "a.txt"), "l1\nl2\nl3\nl4\nl5")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(dir, ".opencode", "hashline"), { recursive: true })
    writeFileSync(
      join(dir, ".opencode", "hashline", "config.json"),
      JSON.stringify({ maxOutputLines: 3 }),
    )
    const { ctx, tools } = makeCtx(dir)
    const cleanup = await plugin.setup(ctx)
    const out = await tools.get("read").execute({ file: "a.txt" }, callCtx())
    expect(out.content.split("\n").filter((l: string) => ROW_RE.test(l))).toHaveLength(3)
    await cleanup?.()
  })

  test("opciones ganan al archivo de proyecto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-win-"))
    writeFileSync(join(dir, "a.txt"), "l1\nl2\nl3\nl4\nl5")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(dir, ".opencode", "hashline"), { recursive: true })
    writeFileSync(
      join(dir, ".opencode", "hashline", "config.json"),
      JSON.stringify({ maxOutputLines: 3 }),
    )
    const { ctx, tools } = makeCtx(dir, { maxOutputLines: 1 })
    const cleanup = await plugin.setup(ctx)
    const out = await tools.get("read").execute({ file: "a.txt" }, callCtx())
    expect(out.content.split("\n").filter((l: string) => ROW_RE.test(l))).toHaveLength(1)
    await cleanup?.()
  })

  test("clave desconocida en opciones rechaza el setup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-unk-"))
    const { ctx } = makeCtx(dir, { nope: 1 })
    await expect(plugin.setup(ctx)).rejects.toThrow(/desconocida|E_INVALID_CONFIG/)
  })

  test("sidecar del store bajo <proyecto>/.opencode/hashline (no tmpdir)", async () => {    const dir = mkdtempSync(join(tmpdir(), "t9-side-"))
    writeFileSync(join(dir, "a.txt"), "a")
    const { ctx, tools } = makeCtx(dir)
    const cleanup = await plugin.setup(ctx)
    await tools.get("read").execute({ file: "a.txt" }, callCtx("sess-x"))
    const { readdirSync } = await import("node:fs")
    const names = readdirSync(join(dir, ".opencode", "hashline")).filter((n: string) =>
      n.endsWith(".sqlite"),
    )
    expect(names).toEqual(["sess-x.sqlite"])
    await cleanup?.()
  })

  test("storeDir por opciones reubica el sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-storedir-"))
    writeFileSync(join(dir, "a.txt"), "a")
    const custom = join(dir, "custom-sidecars")
    const { ctx, tools } = makeCtx(dir, { storeDir: custom })
    const cleanup = await plugin.setup(ctx)
    await tools.get("read").execute({ file: "a.txt" }, callCtx("s1"))
    const { readdirSync } = await import("node:fs")
    expect(readdirSync(custom)).toEqual(["s1.sqlite"])
    await cleanup?.()
  })
})

// Costura: unificación admisión→tools (divergencia #5/#8): lo anotado vía
// hook prompt resuelve en los tools sin stale, misma sesión.
describe("t9 unificación store admisión/tools", () => {
  test("@file anotado y luego editado por anchor sin stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-uni-"))
    const src = join(dir, "doc.txt")
    writeFileSync(src, "one\ntwo\nthree")
    const { ctx, tools, hooks } = makeCtx(dir)
    const cleanup = await plugin.setup(ctx)
    const prompt = { text: "mira", files: [{ uri: src }] }
    await hooks.get("prompt")!({ sessionID: "s1", prompt } as any)
    // Los anchors servidos en admisión (temp anotado) resuelven en los tools.
    const { readFile } = await import("node:fs/promises")
    const tempBody = await readFile((prompt.files as any[])[0].uri, "utf-8")
    const admitted = tempBody
      .split("\n")
      .filter((l: string) => ROW_RE.test(l))
      .map((l: string) => l.slice(0, 4))
    expect(admitted).toHaveLength(3)
    const rep = await tools
      .get("replace")
      .execute(
        { file: "doc.txt", startAnchor: admitted[0], endAnchor: admitted[0], content: "ONE" },
        callCtx("s1"),
      )
    expect(rep.metadata.changed).toBe(true)
    await cleanup?.()
  })
})
