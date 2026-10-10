import { describe, expect, test } from "bun:test"

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

const ROW_RE = /^[a-z]{4}│/

function project() {
  return mkdtempSync(join(tmpdir(), "t7-"))
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

describe("t7 batch mismo-mensaje mismo-archivo", () => {
  test("dos replaces del mismo mensaje = un solo undo", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc\nd")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[0].anchor, endAnchor: before[0].anchor, content: "A" },
        ctx,
      )
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[3].anchor, endAnchor: before[3].anchor, content: "D" },
        ctx,
      )
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nb\nc\nD")
    const undo = await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(undo.content).toMatch(/undo a\.txt/)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nb\nc\nd")
    // Nivel único consumido: segundo undo no tiene nada que restaurar.
    await expect(tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)).rejects.toThrow(
      /E_UNDO_EMPTY/,
    )
    await cleanup?.()
  })

  test("replace + insert del mismo mensaje comparten un undo", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nc")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[1].anchor, endAnchor: before[1].anchor, content: "C" },
        ctx,
      )
    const mid = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("insert")
      .execute({ file: "a.txt", anchor: mid[0].anchor, position: "after", content: "b" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nb\nC")
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nc")
    await cleanup?.()
  })

  test("mensajes distintos = undos separados", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb")
    const { tools, cleanup } = await setup(dir)
    const r1 = await anchorsOf(tools, "a.txt", callCtx("s1", "m1"))
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: r1[0].anchor, endAnchor: r1[0].anchor, content: "A" },
        callCtx("s1", "m1"),
      )
    const r2 = await anchorsOf(tools, "a.txt", callCtx("s1", "m2"))
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: r2[1].anchor, endAnchor: r2[1].anchor, content: "B" },
        callCtx("s1", "m2"),
      )
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nB")
    await tools.get("undo_last_change").execute({ file: "a.txt" }, callCtx("s1", "m3"))
    // Separa niveles: el undo cubre solo el último mensaje, no el original.
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nb")
    // Single-level: el batch anterior ya fue sobrescrito, no hay más undo.
    await expect(
      tools.get("undo_last_change").execute({ file: "a.txt" }, callCtx("s1", "m4")),
    ).rejects.toThrow(/E_UNDO_EMPTY/)
    await cleanup?.()
  })

  test("mismo mensaje, archivos distintos = undos separados", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a")
    writeFileSync(join(dir, "b.txt"), "b")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const ra = await anchorsOf(tools, "a.txt", ctx)
    const rb = await anchorsOf(tools, "b.txt", ctx)
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: ra[0].anchor, endAnchor: ra[0].anchor, content: "A" },
        ctx,
      )
    await tools
      .get("replace")
      .execute(
        { file: "b.txt", startAnchor: rb[0].anchor, endAnchor: rb[0].anchor, content: "B" },
        ctx,
      )
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a")
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("B")
    await cleanup?.()
  })
})

describe("t7 batch: fallos aislados vs aborto", () => {
  test("call inválida falla sola sin abortar hermanas", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[0].anchor, endAnchor: before[0].anchor, content: "A" },
        ctx,
      )
    await expect(
      tools
        .get("replace")
        .execute(
          { file: "a.txt", startAnchor: "zzzz", endAnchor: "zzzz", content: "X" },
          ctx,
        ),
    ).rejects.toThrow(/E_ANCHOR_STALE/)
    // La hermana posterior sigue aplicando: el batch no abortó.
    const mid = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: mid[2].anchor, endAnchor: mid[2].anchor, content: "C" },
        ctx,
      )
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nb\nC")
    // Un solo undo cubre las dos hermanas válidas.
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nb\nc")
    await cleanup?.()
  })

  test("rangos solapados en el mismo batch se rechazan", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc\nd")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("replace")
      .execute(
        {
          file: "a.txt",
          startAnchor: before[0].anchor,
          endAnchor: before[1].anchor,
          content: "A\nB",
        },
        ctx,
      )
    const mid = await anchorsOf(tools, "a.txt", ctx)
    // Solapa la región ya editada (línea de "B" creada por el batch).
    await expect(
      tools
        .get("replace")
        .execute(
          {
            file: "a.txt",
            startAnchor: mid[1].anchor,
            endAnchor: mid[2].anchor,
            content: "X\nY",
          },
          ctx,
        ),
    ).rejects.toThrow(/E_BATCH_OVERLAP/)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nB\nc\nd")
    // Rango disjunto sí aplica dentro del mismo batch.
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: mid[3].anchor, endAnchor: mid[3].anchor, content: "D" },
        ctx,
      )
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nB\nc\nD")
    await cleanup?.()
  })

  test("insert sobre anchor creado por el batch solapa", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("insert")
      .execute({ file: "a.txt", anchor: before[0].anchor, position: "after", content: "x" }, ctx)
    const mid = await anchorsOf(tools, "a.txt", ctx)
    const created = mid.find((r) => r.content === "x")!
    await expect(
      tools
        .get("insert")
        .execute({ file: "a.txt", anchor: created.anchor, position: "after", content: "y" }, ctx),
    ).rejects.toThrow(/E_BATCH_OVERLAP/)
    await cleanup?.()
  })

  test("mismo rango dos veces en el mismo mensaje → E_BATCH_OVERLAP", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("replace")
      .execute(
        {
          file: "a.txt",
          startAnchor: before[0].anchor,
          endAnchor: before[1].anchor,
          content: "A\nB",
        },
        ctx,
      )
    // Mismos anchors originales sin re-leer: solape, no stale.
    await expect(
      tools
        .get("replace")
        .execute(
          {
            file: "a.txt",
            startAnchor: before[0].anchor,
            endAnchor: before[1].anchor,
            content: "X\nY",
          },
          ctx,
        ),
    ).rejects.toThrow(/E_BATCH_OVERLAP/)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nB\nc")
    await cleanup?.()
  })

  test("insert dos veces sobre el mismo anchor en el mismo mensaje → E_BATCH_OVERLAP", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("insert")
      .execute({ file: "a.txt", anchor: before[0].anchor, position: "after", content: "x" }, ctx)
    await expect(
      tools
        .get("insert")
        .execute({ file: "a.txt", anchor: before[0].anchor, position: "after", content: "y" }, ctx),
    ).rejects.toThrow(/E_BATCH_OVERLAP/)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nx\nb")
    await cleanup?.()
  })

  test("fallo de commit aborta el batch con marca explícita", async () => {
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
    // Commit imposible (>1MiB): aborta el batch y deja marca.
    try {
      await tools
        .get("replace")
        .execute(
          {
            file: "a.txt",
            startAnchor: before[1].anchor,
            endAnchor: before[1].anchor,
            content: `y${"z".repeat(1_048_576)}`,
          },
          ctx,
        )
      expect.unreachable()
    } catch (err: any) {
      expect(String(err)).toMatch(/E_FILE_OVERSIZE/)
      expect(String(err)).toMatch(/BATCH_ABORTED/)
    }
    // La hermana posterior, aunque válida, recibe el aborto explícito.
    const mid = await anchorsOf(tools, "a.txt", callCtx("s1", "otra-lectura"))
    await expect(
      tools
        .get("replace")
        .execute(
          { file: "a.txt", startAnchor: mid[1].anchor, endAnchor: mid[1].anchor, content: "B" },
          ctx,
        ),
    ).rejects.toThrow(/E_BATCH_ABORTED/)
    // El primer edit sigue en disco; su undo sigue disponible.
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nb")
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nb")
    await cleanup?.()
  })

  test("fallo de archivo aborta el batch con marca explícita", async () => {
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
    rmSync(join(dir, "a.txt"))
    try {
      await tools
        .get("replace")
        .execute(
          { file: "a.txt", startAnchor: before[1].anchor, endAnchor: before[1].anchor, content: "B" },
          ctx,
        )
      expect.unreachable()
    } catch (err: any) {
      expect(String(err)).toMatch(/E_FILE_NOT_FOUND/)
      expect(String(err)).toMatch(/BATCH_ABORTED/)
    }
    writeFileSync(join(dir, "a.txt"), "A\nb")
    await expect(
      tools
        .get("insert")
        .execute({ file: "a.txt", anchor: before[0].anchor, position: "after", content: "x" }, ctx),
    ).rejects.toThrow(/E_BATCH_ABORTED/)
    await cleanup?.()
  })
})

describe("t7 undo_last_change", () => {
  test("restaura líneas borradas por un replace", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc")
    const { tools, cleanup } = await setup(dir)
    const ctx = callCtx("s1", "m1")
    const before = await anchorsOf(tools, "a.txt", ctx)
    await tools
      .get("replace")
      .execute(
        {
          file: "a.txt",
          startAnchor: before[0].anchor,
          endAnchor: before[2].anchor,
          content: "solo",
        },
        ctx,
      )
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("solo")
    const out = await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nb\nc")
    expect(out.metadata.restored).toBe(true)
    await cleanup?.()
  })

  test("recrea el archivo si fue borrado tras el edit", async () => {
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
    rmSync(join(dir, "a.txt"))
    await tools.get("undo_last_change").execute({ file: "a.txt" }, ctx)
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nb")
    await cleanup?.()
  })

  test("falla stale si el archivo cambió desde el edit", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb")
    const { tools, cleanup } = await setup(dir)
    const before = await anchorsOf(tools, "a.txt", callCtx("s1", "m1"))
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[0].anchor, endAnchor: before[0].anchor, content: "A" },
        callCtx("s1", "m1"),
      )
    writeFileSync(join(dir, "a.txt"), "A\nB-externo")
    try {
      await tools.get("undo_last_change").execute({ file: "a.txt" }, callCtx("s1", "m2"))
      expect.unreachable()
    } catch (err: any) {
      expect(String(err)).toMatch(/E_ANCHOR_STALE/)
      expect(err.rows?.map((r: any) => r.content) ?? String(err)).toEqual(["A", "B-externo"])
    }
    // El archivo externo no se tocó.
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("A\nB-externo")
    await cleanup?.()
  })

  test("falla stale aunque el cambio externo se haya releído", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb")
    const { tools, cleanup } = await setup(dir)
    const before = await anchorsOf(tools, "a.txt", callCtx("s1", "m1"))
    await tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[0].anchor, endAnchor: before[0].anchor, content: "A" },
        callCtx("s1", "m1"),
      )
    writeFileSync(join(dir, "a.txt"), "A\nB-externo")
    await tools.get("read").execute({ file: "a.txt" }, callCtx("s1", "m2"))
    await expect(
      tools.get("undo_last_change").execute({ file: "a.txt" }, callCtx("s1", "m3")),
    ).rejects.toThrow(/E_ANCHOR_STALE/)
    await cleanup?.()
  })

  test("sin cambios propios → E_UNDO_EMPTY", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a")
    const { tools, cleanup } = await setup(dir)
    await tools.get("read").execute({ file: "a.txt" }, callCtx("s1", "m1"))
    await expect(
      tools.get("undo_last_change").execute({ file: "a.txt" }, callCtx("s1", "m2")),
    ).rejects.toThrow(/E_UNDO_EMPTY/)
    await cleanup?.()
  })

  test("sobrevive restarts", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb\nc")
    const first = await setup(dir)
    const before = await anchorsOf(first.tools, "a.txt", callCtx("s1", "m1"))
    await first.tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[1].anchor, endAnchor: before[1].anchor, content: "B" },
        callCtx("s1", "m1"),
      )
    await first.cleanup?.()
    const second = await setup(dir)
    await second.tools.get("undo_last_change").execute({ file: "a.txt" }, callCtx("s1", "m2"))
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("a\nb\nc")
    await second.cleanup?.()
  })

  test("stale sobrevive restarts con lectura intermedia", async () => {
    const dir = project()
    writeFileSync(join(dir, "a.txt"), "a\nb")
    const first = await setup(dir)
    const before = await anchorsOf(first.tools, "a.txt", callCtx("s1", "m1"))
    await first.tools
      .get("replace")
      .execute(
        { file: "a.txt", startAnchor: before[0].anchor, endAnchor: before[0].anchor, content: "A" },
        callCtx("s1", "m1"),
      )
    writeFileSync(join(dir, "a.txt"), "A\nB-externo")
    await first.tools.get("read").execute({ file: "a.txt" }, callCtx("s1", "m2"))
    await first.cleanup?.()
    const second = await setup(dir)
    await expect(
      second.tools.get("undo_last_change").execute({ file: "a.txt" }, callCtx("s1", "m3")),
    ).rejects.toThrow(/E_ANCHOR_STALE/)
    await second.cleanup?.()
  })
})
