import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"

import plugin from "../src/index"

function stubCtx() {
  const hooks = new Map<string, (input: any) => Promise<void> | void>()
  return {
    ctx: {
      location: { project: { id: "t8-test-proj" } },
      session: {
        hook: async (name: string, cb: (input: any) => Promise<void> | void) => {
          hooks.set(name, cb)
          return { dispose: async () => {} }
        },
      },
    } as any,
    hooks,
  }
}

// Costura: setup registra el hook de admisión y su cleanup limpia temps.
describe("setup atfile wiring", () => {
  test("hook prompt anota files[] y cleanup elimina temps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t8-wire-"))
    const src = join(dir, "a.ts")
    writeFileSync(src, "one\ntwo")
    const { ctx, hooks } = stubCtx()
    const cleanup = (await plugin.setup(ctx)) as (() => Promise<void>) | void
    expect(hooks.has("prompt")).toBe(true)
    const prompt = { text: "mira esto", files: [{ uri: src }] }
    await hooks.get("prompt")!({ sessionID: "sess1", prompt } as any)
    const temp = (prompt.files as any[])[0].uri as string
    expect(temp).not.toBe(src)
    const body = await readFile(temp, "utf-8")
    expect(body.split("\n")).toHaveLength(2)
    expect(body).toMatch(/^[a-z]{4}│one/m)
    // Re-ejecución del hook (no exactly-once): no duplica anotación.
    await hooks.get("prompt")!({ sessionID: "sess1", prompt } as any)
    expect((prompt.files as any[])[0].uri).toBe(temp)
    expect(await readFile(temp, "utf-8")).toBe(body)
    await cleanup!()
    await expect(readFile(temp, "utf-8")).rejects.toThrow()
  })

  test("omitido por guarda: nota visible sin romper admisión ni duplicar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t8-wire-"))
    const good = join(dir, "ok.ts")
    writeFileSync(good, "a\nb")
    const bad = join(dir, "bin.dat")
    writeFileSync(bad, "ab\0cd")
    const { ctx, hooks } = stubCtx()
    const cleanup = (await plugin.setup(ctx)) as (() => Promise<void>) | void
    const prompt = { text: "mira esto", files: [{ uri: good }, { uri: bad }] }
    await hooks.get("prompt")!({ sessionID: "sess1", prompt } as any)
    // El bueno se anota, el binario se admite tal cual.
    expect((prompt.files as any[])[0].uri).not.toBe(good)
    expect((prompt.files as any[])[1].uri).toBe(bad)
    expect(prompt.text).toMatch(/H_ATFILE_SKIPPED/)
    expect(prompt.text).toMatch(/E_FILE_BINARY/)
    // Re-ejecución: sin nota duplicada.
    const once = prompt.text
    await hooks.get("prompt")!({ sessionID: "sess1", prompt } as any)
    expect(prompt.text).toBe(once)
    await cleanup!()
  })

  test("el hook nunca rompe la admisión aunque todo falle", async () => {
    const { ctx, hooks } = stubCtx()
    const cleanup = (await plugin.setup(ctx)) as (() => Promise<void>) | void
    await hooks.get("prompt")!({
      sessionID: "sess-bad",
      prompt: { text: "x", files: [{ uri: "\0" }] },
    } as any)
    await hooks.get("prompt")!({ sessionID: "sess-bad", prompt: { text: "sin files" } } as any)
    await cleanup!()
  })
})
