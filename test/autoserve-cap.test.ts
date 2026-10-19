import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAnchorStore } from "../src/anchor-store"
import { withProjectKeys } from "../src/config"
import { autoServeMentionedPaths } from "../src/atfile"
import plugin from "../src/index"

function project(): string {
  return mkdtempSync(join(tmpdir(), "t21-cap-"))
}

function memStore(sessionId = "s21") {
  return createAnchorStore({ sessionId, storePath: ":memory:" })
}

// 11 archivos de 2 líneas cada uno, nombres ordenables f00..f10.
function eleven(dir: string): string[] {
  const names: string[] = []
  for (let i = 0; i < 11; i++) {
    const n = `f${String(i).padStart(2, "0")}.txt`
    writeFileSync(join(dir, n), `l${i}a\nl${i}b`)
    names.push(n)
  }
  return names
}

// AC1: 11 referenciados → 10 servidos + nota con el restante (orden del Gate).
describe("tope 10 por mensaje #21", () => {
  test("11 referenciados → 10 primeros servidos + 1 skip con motivo de tope", async () => {
    const dir = project()
    const names = eleven(dir)
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths(names.join(" "), dir, proj)
    expect(served.map((s) => s.file)).toEqual(names.slice(0, 10))
    expect(skipped).toHaveLength(1)
    expect(skipped[0].file).toBe(names[10])
    expect(skipped[0].reason).toMatch(/tope/i)
    expect(skipped[0].reason).not.toMatch(/E_[A-Z_]+/)
    // El 11º no deja served-record.
    expect(proj.peek(join(dir, names[10]))).toBeNull()
    store.close()
  })

  test("10 o menos → todo servido, sin nota de tope", async () => {
    const dir = project()
    const names = eleven(dir).slice(0, 10)
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    const { served, skipped } = await autoServeMentionedPaths(names.join(" "), dir, proj)
    expect(served.map((s) => s.file)).toEqual(names)
    expect(skipped).toEqual([])
    store.close()
  })

  test("skips del Gate no consumen cupo del tope", async () => {
    const dir = project()
    const names = eleven(dir)
    const store = memStore()
    const proj = withProjectKeys(store, dir)
    // Skips del Gate intercalados: fuera del proyecto al inicio, excluido al final.
    const text = `@../fuera.txt ${names.join(" ")} @package-lock.json`
    writeFileSync(join(dir, "package-lock.json"), "x\ny")
    const { served, skipped } = await autoServeMentionedPaths(text, dir, proj)
    // Los 10 primeros válidos se sirven aunque haya skips entre medias.
    expect(served.map((s) => s.file)).toEqual(names.slice(0, 10))
    expect(skipped.map((s) => s.file)).toEqual(["../fuera.txt", names[10], "package-lock.json"])
    expect(skipped[1].reason).toMatch(/tope/i)
    for (const s of skipped) expect(s.reason).not.toMatch(/E_[A-Z_]+/)
    store.close()
  })
})

// AC punta a punta: el hook sirve 10 y el resto queda en nota.
describe("tope 10 punta a punta #21", () => {
  test("mensaje con 11 paths → 10 editables + H_AUTO_READ con tope", async () => {
    const dir = project()
    const names = eleven(dir)
    const tools = new Map<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }>()
    const hooks = new Map<string, (input: unknown) => Promise<void> | void>()
    const ctx = {
      location: {
        directory: dir,
        project: { id: "t21-proj", directory: dir, canonical: dir },
      },
      options: {},
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
    const cleanup = (await plugin.setup(ctx)) as () => Promise<void>
    const prompt = { text: `revisa ${names.join(" ")}` } as { text: string }
    await hooks.get("prompt")!({ sessionID: "s1", prompt } as unknown)
    expect(prompt.text).toMatch(/H_AUTO_READ/)
    expect(prompt.text).toMatch(/tope/i)
    expect(prompt.text).toContain(names[10])
    // El 10º servido es editable por anchor sin `read` previo.
    const rowRe = /^[a-z]{4}│/m
    const anchor10 = prompt.text
      .split("\n")
      .filter((l) => rowRe.test(l) && l.includes("l9a"))
      .map((l) => l.slice(0, 4))[0]
    expect(anchor10).toBeDefined()
    const callCtx = {
      sessionID: "s1",
      agent: "a",
      messageID: "m1",
      id: "c-m1",
      signal: new AbortController().signal,
      progress: async () => {},
    }
    await tools.get("replace")!.execute(
      { file: names[9], startAnchor: anchor10, content: "EDITED" },
      callCtx,
    )
    const { readFile } = await import("node:fs/promises")
    expect(await readFile(join(dir, names[9]), "utf-8")).toContain("EDITED")
    // El 11º sin served-record: anchor_grep lo ve no servido.
    const grep = (await tools.get("anchor_grep")!.execute(
      { file: names[10], pattern: "l10a" },
      callCtx,
    )) as { metadata: { served: boolean } }
    expect(grep.metadata.served).toBe(false)
    await (cleanup as () => Promise<void>)()
  })
})
