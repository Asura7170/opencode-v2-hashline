import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/m

function project(): string {
  return mkdtempSync(join(tmpdir(), "t19-wire-"))
}

function makeCtx(projectDir: string, options: Record<string, unknown> = {}) {
  const tools = new Map<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }>()
  const hooks = new Map<string, (input: unknown) => Promise<void> | void>()
  const ctx = {
    location: {
      directory: projectDir,
      project: { id: "t19-proj", directory: projectDir, canonical: projectDir },
    },
    options,
    session: {
      hook: async (name: string, cb: (input: unknown) => Promise<void> | void) => {
        hooks.set(name, cb)
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        const editor = {
          list: () => [],
          get: (id: string) => tools.get(id),
          namespace: () => {},
          add: (t: { name: string; execute: unknown }) => {
            tools.set(t.name, t as { execute: (input: unknown, ctx: unknown) => Promise<unknown> })
          },
          update: () => {},
          remove: () => {},
        }
        cb(editor)
        return { dispose: async () => {} }
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]
  return { ctx, tools, hooks }
}

function callCtx(sessionID: string, messageID: string) {
  return {
    sessionID,
    agent: "a",
    messageID,
    id: `c-${messageID}`,
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

async function promptOf(
  hooks: Map<string, (input: unknown) => Promise<void> | void>,
  sessionID: string,
  prompt: { text: string; files?: { uri: string }[] },
): Promise<{ text: string; files?: { uri: string }[] }> {
  await hooks.get("prompt")!({ sessionID, prompt } as unknown)
  return prompt
}

// AC1: adjunto @file del proyecto servido y editable por anchor sin `read` previo.
describe("t19 auto-serve por hook", () => {
  test("adjunto llega servido, editable sin read, y con resumen", async () => {
    const dir = project()
    const src = join(dir, "a.txt")
    writeFileSync(src, "one\ntwo")
    const { ctx, tools, hooks } = makeCtx(dir)
    const cleanup = (await plugin.setup(ctx)) as () => Promise<void>
    const prompt = await promptOf(hooks, "s1", { text: "edita esto", files: [{ uri: src }] })
    // Swap al temp anotado (conducta previa intacta).
    const temp = prompt.files![0].uri
    expect(temp).not.toBe(src)
    const anchor = rowsOf(await readFile(temp, "utf-8"))[0].anchor
    // Sin `read` previo: replace directo por anchor del adjunto.
    const replace = tools.get("replace")!
    const out = (await replace.execute(
      { file: "a.txt", startAnchor: anchor, content: "ONE" },
      callCtx("s1", "m1"),
    )) as { content: string }
    expect(out.content).toMatch(/replace a\.txt/)
    expect(await readFile(src, "utf-8")).toBe("ONE\ntwo")
    // Resumen por mensaje con lo auto-servido.
    expect(prompt.text).toMatch(/H_AUTO_READ/)
    expect(prompt.text).toContain("a.txt")
    await (cleanup as () => Promise<void>)()
  })

  // AC2+AC3: path mencionado queda servido, con resumen y filas visibles sin `read`.
  test("path mencionado queda servido con resumen", async () => {
    const dir = project()
    writeFileSync(join(dir, "b.txt"), "alpha\nbeta")
    const { ctx, tools, hooks } = makeCtx(dir)
    const cleanup = (await plugin.setup(ctx)) as () => Promise<void>
    const prompt = await promptOf(hooks, "s2", { text: "revisa b.txt por favor" })
    expect(prompt.text).toMatch(/H_AUTO_READ/)
    expect(prompt.text).toContain("b.txt")
    const anchor = rowsOf(prompt.text)[0].anchor
    const replace = tools.get("replace")!
    await replace.execute({ file: "b.txt", startAnchor: anchor, content: "ALPHA" }, callCtx("s2", "m1"))
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("ALPHA\nbeta")
    await (cleanup as () => Promise<void>)()
  })

  test("sin referencias no hay resumen y el re-hook no duplica", async () => {
    const dir = project()
    writeFileSync(join(dir, "c.txt"), "x\ny")
    const { ctx, hooks } = makeCtx(dir)
    const cleanup = (await plugin.setup(ctx)) as () => Promise<void>
    const prompt = await promptOf(hooks, "s3", { text: "hola sin refs" })
    expect(prompt.text).not.toMatch(/H_AUTO_READ/)
    const withRef = await promptOf(hooks, "s3", { text: "mira c.txt" })
    const once = withRef.text
    expect(once).toMatch(/H_AUTO_READ/)
    await promptOf(hooks, "s3", withRef)
    expect(withRef.text).toBe(once)
    await (cleanup as () => Promise<void>)()
  })

  // AC4: indistinguible aguas abajo — read tras auto-serve no realoca, edit+undo iguales.
  test("auto-servido indistinguible: read estable + edit + undo", async () => {    const dir = project()
    writeFileSync(join(dir, "d.txt"), "k1\nk2")
    const { ctx, tools, hooks } = makeCtx(dir)
    const cleanup = (await plugin.setup(ctx)) as () => Promise<void>
    const prompt = await promptOf(hooks, "s4", { text: "toca d.txt" })
    const autoRows = rowsOf(prompt.text)
    // `read` manual no realoca: mismos anchors que el auto-servido.
    const read = tools.get("read")!
    const out = (await read.execute({ file: "d.txt" }, callCtx("s4", "m1"))) as { content: string }
    expect(rowsOf(out.content).map((r) => r.anchor)).toEqual(autoRows.map((r) => r.anchor))
    // Edit + undo sobre auto-servido como sobre `read` manual.
    const replace = tools.get("replace")!
    await replace.execute(
      { file: "d.txt", startAnchor: autoRows[0].anchor, content: "K1" },
      callCtx("s4", "m2"),
    )
    expect(await readFile(join(dir, "d.txt"), "utf-8")).toBe("K1\nk2")
    const undo = tools.get("undo_last_change")!
    await undo.execute({ file: "d.txt" }, callCtx("s4", "m3"))
    expect(await readFile(join(dir, "d.txt"), "utf-8")).toBe("k1\nk2")
    await (cleanup as () => Promise<void>)()
  })

  // Gate #20: cada skip motivado en el resumen, sin servir ni abrir batch.
  test("skips motivados en el resumen sin served-record ni batch", async () => {
    const dir = project()
    writeFileSync(join(dir, "ok.txt"), "a\nb")
    writeFileSync(join(dir, "nuevo.txt"), "c\nd")
    // Cuota para 2 anchors: ok.txt cabe, nuevo.txt ya no.
    const { ctx, tools, hooks } = makeCtx(dir, { maxAnchors: 2 })
    const cleanup = (await plugin.setup(ctx)) as () => Promise<void>
    const prompt = await promptOf(hooks, "s5", { text: "revisa ok.txt nuevo.txt y ../fuera.txt" })
    expect(prompt.text).toMatch(/H_AUTO_READ/)
    expect(prompt.text).toContain("ok.txt (2 lines)")
    expect(prompt.text).toMatch(/nuevo\.txt.*[Cc]uota/)
    expect(prompt.text).toMatch(/fuera del proyecto/)
    // Sin served-record: grep lo ve no servido (lectura sin efectos).
    const grep = (await tools.get("anchor_grep")!.execute(
      { file: "nuevo.txt", pattern: "c" },
      callCtx("s5", "m1"),
    )) as { metadata: { served: boolean } }
    expect(grep.metadata.served).toBe(false)
    // Sin batch ni sombra: el undo no tiene nada que deshacer.
    await expect(
      tools.get("undo_last_change")!.execute({ file: "nuevo.txt" }, callCtx("s5", "m2")),
    ).rejects.toThrow(/E_UNDO_EMPTY/)
    expect(await readFile(join(dir, "nuevo.txt"), "utf-8")).toBe("c\nd")
    await (cleanup as () => Promise<void>)()
  })
})
