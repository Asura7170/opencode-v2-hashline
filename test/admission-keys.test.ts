import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/

function makeCtx(projectDir: string) {
  const tools = new Map<string, any>()
  const sessionHooks = new Map<string, (input: any) => any>()
  const ctx = {
    location: {
      directory: projectDir,
      project: { id: "p1", directory: projectDir, canonical: projectDir },
    },
    options: {},
    session: {
      hook: async (name: string, cb: (input: any) => any) => {
        sessionHooks.set(name, cb)
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
      hook: async () => ({ dispose: async () => {} }),
    },
  } as any
  return { ctx, tools, sessionHooks }
}

// Costura: un anchor servido en admisión (@file, path absoluto) resuelve en
// `replace` (clave relativa) sin lectura previa: misma normalización
// withProjectKeys en ambos lados (#5/#8).
describe("admisión y tools comparten claves", () => {
  test("anchor de admisión resuelve en replace sin read previo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t11-keys-"))
    const abs = join(dir, "a.txt")
    writeFileSync(abs, "one\ntwo\nthree")
    const { ctx, tools, sessionHooks } = makeCtx(dir)
    const cleanup = await plugin.setup(ctx)
    const prompt = { text: "mira esto", files: [{ uri: abs }] }
    await sessionHooks.get("prompt")!({ sessionID: "s1", prompt } as any)
    // Swap al temp anotado: el anchor de "two" debe servir para replace.
    expect(prompt.files[0].uri).not.toBe(abs)
    const temp = await readFile(prompt.files[0].uri, "utf-8")
    const row = temp.split("\n").find((l) => l.endsWith("│two"))
    expect(row).toMatch(ROW_RE)
    const anchor = row!.slice(0, 4)
    const callCtx = {
      sessionID: "s1",
      agent: "a",
      messageID: "m1",
      id: "c1",
      signal: new AbortController().signal,
      progress: async () => {},
    } as any
    const out = await tools
      .get("replace")
      .execute({ file: "a.txt", startAnchor: anchor, endAnchor: anchor, content: "TWO" }, callCtx)
    expect(out.content).toMatch(/TWO/)
    expect(await readFile(abs, "utf-8")).toBe("one\nTWO\nthree")
    await cleanup?.()
  })
})
