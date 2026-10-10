import { describe, expect, test } from "bun:test"

import plugin from "../src/index"
import { stripEchoedAnchors } from "../src/native-guards"

function stubHost() {
  const toolHooks = new Map<string, (input: any) => any>()
  const sessionHooks = new Map<string, (input: any) => any>()
  const ctx = {
    location: { project: { id: "t6-proj" } },
    session: {
      hook: async (name: string, cb: (input: any) => any) => {
        sessionHooks.set(name, cb)
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async () => ({ dispose: async () => {} }),
      hook: async (name: string, cb: (input: any) => any) => {
        toolHooks.set(name, cb)
        return { dispose: async () => {} }
      },
    },
  } as any
  return { ctx, toolHooks, sessionHooks }
}

function beforeInput(tool: string, input: unknown, id = "call-1") {
  return { tool, sessionID: "s1", agent: "a", messageID: "m", id, input } as any
}

// Costura: guardas sobre tools nativas vía hooks (spec #1, historias 9-10)
// + system prompt vía hook de contexto. Sin host: se drivean los hooks
// capturados y se observan input in/out, throws y system inyectado.
describe("strip de ecos en edits nativos", () => {
  test("puro: quita prefijos anchor│ por línea e idempotente", () => {
    const first = stripEchoedAnchors("aaaa│one\nbbbb│two\nplain")
    expect(first.text).toBe("one\ntwo\nplain")
    expect(first.stripped).toBe(2)
    const second = stripEchoedAnchors(first.text)
    expect(second.text).toBe(first.text)
    expect(second.stripped).toBe(0)
  })

  test("before en edit muta el input sin corromper contenido", async () => {
    const { ctx, toolHooks } = stubHost()
    await plugin.setup(ctx)
    const input = { file: "a.txt", oldString: "aaaa│old", newString: "aaaa│new\nbbbb│more" }
    await toolHooks.get("execute.before")!(beforeInput("edit", input))
    expect(input).toEqual({ file: "a.txt", oldString: "old", newString: "new\nmore" })
  })

  test("strip repetido (wrapper codemode re-dispara) es no-op", async () => {
    const { ctx, toolHooks } = stubHost()
    await plugin.setup(ctx)
    const input = { file: "a.txt", newString: "aaaa│new" }
    const before = beforeInput("edit", input)
    await toolHooks.get("execute.before")!(before)
    await toolHooks.get("execute.before")!(before)
    expect(input.newString).toBe("new")
  })

  test("no toca las tools propias aunque traigan anchors", async () => {
    const { ctx, toolHooks } = stubHost()
    await plugin.setup(ctx)
    for (const tool of ["read", "replace", "insert", "undo_last_change"]) {
      const input = { file: "a.txt", content: "aaaa│x" }
      await toolHooks.get("execute.before")!(beforeInput(tool, input))
      expect(input.content).toBe("aaaa│x")
    }
  })

  test("after añade aviso H_ECHO_STRIPPED solo si hubo strip", async () => {
    const { ctx, toolHooks } = stubHost()
    await plugin.setup(ctx)
    const before = toolHooks.get("execute.before")!
    const after = toolHooks.get("execute.after")!
    await before(beforeInput("edit", { file: "a.txt", newString: "aaaa│new" }, "c1"))
    const ok: any = { tool: "edit", id: "c1", status: "completed", input: {}, result: { content: "edited" } }
    await after(ok)
    expect(ok.result.content).toMatch(/H_ECHO_STRIPPED/)
    expect(ok.result.content).toMatch(/1/)
    const untouched: any = { tool: "edit", id: "c2", status: "completed", input: {}, result: { content: "edited" } }
    await after(untouched)
    expect(untouched.result.content).toBe("edited")
  })

  test("after en fallo limpia estado sin romper", async () => {
    const { ctx, toolHooks } = stubHost()
    await plugin.setup(ctx)
    await toolHooks.get("execute.before")!(beforeInput("edit", { newString: "aaaa│x" }, "c9"))
    const failed: any = { tool: "edit", id: "c9", status: "error", input: {}, error: { message: "boom" } }
    await toolHooks.get("execute.after")!(failed)
    // Sin fuga: un completado posterior con el mismo id no recibe aviso.
    const later: any = { tool: "edit", id: "c9", status: "completed", input: {}, result: { content: "ok" } }
    await toolHooks.get("execute.after")!(later)
    expect(later.result.content).toBe("ok")
  })
})

describe("echo-refusal en write nativo", () => {
  test("anchors servidos a write → error estructurado E_ANCHOR_ECHO", async () => {
    const { ctx, toolHooks } = stubHost()
    await plugin.setup(ctx)
    const input = { file: "a.txt", content: "aaaa│one\ntwo" }
    try {
      await toolHooks.get("execute.before")!(beforeInput("write", input))
      expect.unreachable()
    } catch (err: any) {
      expect(String(err)).toMatch(/\[E_ANCHOR_ECHO\]/)
      expect(err.code).toBe("E_ANCHOR_ECHO")
      expect(String(err)).toMatch(/replace|insert/)
    }
  })

  test("write limpio pasa intacto", async () => {
    const { ctx, toolHooks } = stubHost()
    await plugin.setup(ctx)
    const input = { file: "a.txt", content: "one\ntwo" }
    await toolHooks.get("execute.before")!(beforeInput("write", input))
    expect(input.content).toBe("one\ntwo")
  })
})

describe("system prompt vía hook de contexto", () => {
  test("inyecta guía de anchors sin clobber y sin duplicar", async () => {
    const { ctx, sessionHooks } = stubHost()
    await plugin.setup(ctx)
    const hook = sessionHooks.get("context")
    expect(hook).toBeDefined()
    const input: any = { system: [{ type: "text", text: "base" }], messages: [], options: {}, tools: {} }
    await hook!(input)
    expect(input.system).toHaveLength(2)
    expect(input.system[0].text).toBe("base")
    expect(input.system[1].text).toMatch(/anchor/)
    await hook!(input)
    expect(input.system).toHaveLength(2)
  })
})

describe("robustez de guardas", () => {
  test("inputs raros nunca rompen al host", async () => {
    const { ctx, toolHooks, sessionHooks } = stubHost()
    await plugin.setup(ctx)
    const before = toolHooks.get("execute.before")!
    const after = toolHooks.get("execute.after")!
    for (const tool of ["edit", "write", "bash", "read"]) {
      await before(beforeInput(tool, undefined))
      await before(beforeInput(tool, null))
      await before(beforeInput(tool, 42))
    }
    await after({ tool: "edit", id: "zz", status: "completed", input: {}, result: {} } as any)
    await after({ tool: "edit", id: "zz", status: "completed", input: {} } as any)
    await sessionHooks.get("context")!({} as any)
    await sessionHooks.get("context")!(null as any)
  })

  test("setup registra before/after/context", async () => {
    const { ctx, toolHooks, sessionHooks } = stubHost()
    await plugin.setup(ctx)
    expect(toolHooks.has("execute.before")).toBe(true)
    expect(toolHooks.has("execute.after")).toBe(true)
    expect(sessionHooks.has("context")).toBe(true)
  })
})
