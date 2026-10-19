import { describe, expect, test } from "bun:test"

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAnchorStore, type AnchorStore } from "../src/anchor-store"
import { DEFAULT_CONFIG } from "../src/config"
import { registerCoreTools } from "../src/core-tools"

const ROW_RE = /^[a-z]{4}│/

function project() {
  return mkdtempSync(join(tmpdir(), "lost-update-"))
}

function makeCtx(projectDir: string) {
  const tools = new Map<string, any>()
  const ctx = {
    location: {
      directory: projectDir,
      project: { id: "p1", directory: projectDir, canonical: projectDir },
    },
    options: {},
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

/** Hook de un solo disparo sobre un serve concreto: el punto exacto entre el
 * read del snapshot que usa la tool y su escritura. */
type DiskHook = { file: string; mutate: () => void } | null

async function setup(projectDir: string) {
  const { ctx, tools } = makeCtx(projectDir)
  const real = createAnchorStore({
    sessionId: "s1",
    storePath: join(projectDir, "hashline.sqlite"),
    maxFileBytes: DEFAULT_CONFIG.maxFileBytes,
    maxAnchors: DEFAULT_CONFIG.maxAnchors,
    excludes: DEFAULT_CONFIG.excludes,
  })
  let hook: DiskHook = null
  const wrapper: AnchorStore = {
    ...real,
    serve(filePath, content) {
      if (hook && filePath === hook.file) {
        const { mutate } = hook
        hook = null
        mutate()
      }
      return real.serve(filePath, content)
    },
  }
  const cleanup = await registerCoreTools(ctx, {
    config: DEFAULT_CONFIG,
    storeFor: () => wrapper,
  })
  const arm = (file: string, mutate: () => void) => {
    hook = { file, mutate }
  }
  const done = async () => {
    await cleanup()
    real.close()
  }
  return { tools, arm, done }
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

async function rowsOf(tools: Map<string, any>, file: string, ctx: any) {
  const out = await tools.get("read").execute({ file }, ctx)
  return out.content
    .split("\n")
    .filter((l: string) => ROW_RE.test(l))
    .map((l: string) => ({ anchor: l.slice(0, 4), content: l.slice(5) }))
}

function tmpFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".tmp"))
}

describe("lost update: el archivo cambia entre el read y la escritura", () => {
  test("replace aborta con E_FILE_CHANGED sin pisar el cambio externo", async () => {
    const dir = project()
    const abs = join(dir, "a.txt")
    writeFileSync(abs, "one\ntwo\nthree")
    const { tools, arm, done } = await setup(dir)
    const ctx = callCtx()
    const rows = await rowsOf(tools, "a.txt", ctx)
    arm("a.txt", () => writeFileSync(abs, "externo\n"))
    await expect(
      tools.get("replace").execute(
        { file: "a.txt", startAnchor: rows[0].anchor, endAnchor: rows[0].anchor, content: "editado" },
        ctx,
      ),
    ).rejects.toThrow(/E_FILE_CHANGED/)
    expect(await readFile(abs, "utf-8")).toBe("externo\n")
    expect(tmpFiles(dir)).toEqual([])
    await done()
  })

  test("copy aborta con E_FILE_CHANGED si el destino cambió durante su serve", async () => {
    const dir = project()
    const srcAbs = join(dir, "a.txt")
    const dstAbs = join(dir, "b.txt")
    writeFileSync(srcAbs, "a1\na2")
    writeFileSync(dstAbs, "b1\nb2")
    const { tools, arm, done } = await setup(dir)
    const ctx = callCtx()
    const src = await rowsOf(tools, "a.txt", ctx)
    const dst = await rowsOf(tools, "b.txt", ctx)
    arm("b.txt", () => writeFileSync(dstAbs, "externo\n"))
    await expect(
      tools.get("copy").execute(
        {
          file: "a.txt",
          startAnchor: src[0].anchor,
          endAnchor: src[1].anchor,
          destFile: "b.txt",
          destAnchor: dst[0].anchor,
          position: "after",
        },
        ctx,
      ),
    ).rejects.toThrow(/E_FILE_CHANGED/)
    expect(await readFile(dstAbs, "utf-8")).toBe("externo\n")
    expect(await readFile(srcAbs, "utf-8")).toBe("a1\na2")
    await done()
  })

  test("move: origen mutado tras el pre-check → E_FILE_CHANGED (duplicado, nunca pérdida)", async () => {
    const dir = project()
    const srcAbs = join(dir, "a.txt")
    const dstAbs = join(dir, "b.txt")
    writeFileSync(srcAbs, "a1\na2")
    writeFileSync(dstAbs, "b1\nb2")
    const { tools, arm, done } = await setup(dir)
    const ctx = callCtx()
    const src = await rowsOf(tools, "a.txt", ctx)
    const dst = await rowsOf(tools, "b.txt", ctx)
    // Límite conocido: la mutación ocurre durante el serve del destino, o sea
    // después del pre-check del origen y antes de su vaciado. El destino ya
    // commiteó, así que quedan ambos contenidos (duplicado), nunca pérdida.
    arm("b.txt", () => writeFileSync(srcAbs, "externo\n"))
    await expect(
      tools.get("move").execute(
        {
          file: "a.txt",
          startAnchor: src[0].anchor,
          endAnchor: src[1].anchor,
          destFile: "b.txt",
          destAnchor: dst[0].anchor,
          position: "after",
        },
        ctx,
      ),
    ).rejects.toThrow(/E_FILE_CHANGED/)
    expect(await readFile(dstAbs, "utf-8")).toBe("b1\na1\na2\nb2")
    expect(await readFile(srcAbs, "utf-8")).toBe("externo\n")
    await done()
  })

  test("move: pre-check del origen aborta antes de tocar el destino", async () => {
    const dir = project()
    const srcAbs = join(dir, "a.txt")
    const dstAbs = join(dir, "b.txt")
    writeFileSync(srcAbs, "a1\na2")
    writeFileSync(dstAbs, "b1\nb2")
    const { tools, arm, done } = await setup(dir)
    const ctx = callCtx()
    const src = await rowsOf(tools, "a.txt", ctx)
    const dst = await rowsOf(tools, "b.txt", ctx)
    // Mutación durante el serve del propio origen: cae en el pre-check previo
    // al destino, que aborta sin escribir ningún archivo.
    arm("a.txt", () => writeFileSync(srcAbs, "externo\n"))
    await expect(
      tools.get("move").execute(
        {
          file: "a.txt",
          startAnchor: src[0].anchor,
          endAnchor: src[1].anchor,
          destFile: "b.txt",
          destAnchor: dst[0].anchor,
          position: "after",
        },
        ctx,
      ),
    ).rejects.toThrow(/E_FILE_CHANGED/)
    expect(await readFile(dstAbs, "utf-8")).toBe("b1\nb2")
    expect(await readFile(srcAbs, "utf-8")).toBe("externo\n")
    await done()
  })
})
