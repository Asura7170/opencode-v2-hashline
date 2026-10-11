import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/m

function project(): string {
  return mkdtempSync(join(tmpdir(), "t22-"))
}

function makeCtx(projectDir: string) {
  const tools = new Map<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }>()
  const hooks = new Map<string, (input: unknown) => Promise<void> | void>()
  const ctx = {
    location: {
      directory: projectDir,
      project: { id: "t22-proj", directory: projectDir, canonical: projectDir },
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

describe("t22 flujo combinado fase 3", () => {
  test("referencia → auto-serve → edit → skip ajeno → undo", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a1\na2")
    writeFileSync(join(dir, "b.txt"), "b1")
    writeFileSync(join(dir, "c.txt"), "c1")
    const { ctx, tools, hooks } = makeCtx(dir)
    const cleanup = (await plugin.setup(ctx)) as () => Promise<void>

    // c.txt con dueño ajeno: servido en s9 con anchor real.
    await tools.get("read")!.execute({ file: "c.txt" }, callCtx("s9", "m1"))

    // s1 referencia a.txt (adjunto), b.txt y c.txt (mencionados).
    const prompt = await promptOf(hooks, "s1", {
      text: "toca b.txt y revisa c.txt",
      files: [{ uri: join(dir, "a.txt") }],
    })
    expect(prompt.text).toMatch(/H_AUTO_READ/)
    expect(prompt.text).toContain("a.txt")
    expect(prompt.text).toContain("b.txt")
    // c.txt ajeno: skip motivado, sin robo.
    expect(prompt.text).toContain("c.txt")

    // Edit sobre auto-servido sin `read` previo (anchor del temp swappeado).
    const temp = prompt.files![0].uri
    const anchor = rowsOf(await readFile(temp, "utf-8")).find((r) => r.content === "a1")!.anchor
    await tools
      .get("replace")!
      .execute({ file: "a.txt", startAnchor: anchor, content: "A1" }, callCtx("s1", "m1"))
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A1\na2")
    // c.txt intacto: el skip no tocó nada.
    expect(await readFile(join(dir, "c.txt"), "utf-8")).toBe("c1")

    // Undo restaura a.txt.
    await tools.get("undo_last_change")!.execute({ file: "a.txt" }, callCtx("s1", "m2"))
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a1\na2")
    await (cleanup as () => Promise<void>)()
  })
})
