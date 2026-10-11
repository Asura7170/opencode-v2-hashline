import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Plugin } from "@opencode/plugin"

import { type AnchorStore, createAnchorStore } from "./anchor-store"
import {
  annotateAttachments,
  autoServeMentionedPaths,
  cleanupAtFile,
  createAtFileState,
  formatAutoReadNote,
  toFsPath,
  type AutoServeSummary,
} from "./atfile"
import {
  loadHashlineConfig,
  relativeKeyFor,
  storePathFor,
  withProjectKeys,
  type HashlineConfig,
} from "./config"
import { registerCoreTools } from "./core-tools"
import { registerNativeGuards } from "./native-guards"

interface LocationLike {
  location?: {
    project?: { directory?: unknown }
    directory?: unknown
  }
}

function projectDirOf(ctx: LocationLike): string | null {
  const dir = ctx.location?.project?.directory ?? ctx.location?.directory
  return typeof dir === "string" && dir !== "" ? dir : null
}

function openStore(projectDir: string | null, sessionID: string, cfg: HashlineConfig): AnchorStore {
  // Sidecar canónico keyeado por proyecto+sesión, compartido por admisión y tools.
  // Sin proyecto (ctx parcial en tests): tmpdir como antes.
  const storePath =
    projectDir === null
      ? join(tmpdir(), `opencode-hashline-${sessionID.replace(/[^A-Za-z0-9._-]+/g, "_")}.sqlite`)
      : storePathFor(projectDir, sessionID, cfg.storeDir)
  if (projectDir !== null) mkdirSync(dirname(storePath), { recursive: true })
  return createAnchorStore({
    sessionId: sessionID,
    storePath,
    maxFileBytes: cfg.maxFileBytes,
    maxAnchors: cfg.maxAnchors,
    excludes: cfg.excludes,
  })
}

export default Plugin.define({
  id: "opencode-hashline",
  async setup(ctx) {
    const projectDir = projectDirOf(ctx)
    // Desconocidas o inválidas rechazan el setup (sanitize).
    const cfg = await loadHashlineConfig({ projectDir: projectDir ?? undefined, options: ctx.options })
    const atfile = createAtFileState()
    // Un store por sesión compartido por admisión (@file) y tools: mismo
    // sidecar y mismas claves relativas → sin stale entre ambos (#5/#8).
    const stores = new Map<string, AnchorStore>()
    const storeFor = (sessionID: string): AnchorStore => {
      let store = stores.get(sessionID)
      if (!store) {
        store = openStore(projectDir, sessionID, cfg)
        stores.set(sessionID, store)
      }
      return store
    }
    await ctx.session.hook("prompt", async (input) => {
      try {
        const store = storeFor(input.sessionID)
        const projStore = projectDir ? withProjectKeys(store, projectDir) : store
        const files = input.prompt.files as { uri: string }[] | undefined
        const before = (files ?? []).map((f) => f?.uri)
        const skipped = await annotateAttachments(files, projStore, atfile)
        // Admisión explícita sin romperla: los omitidos por guarda viajan
        // como nota visible en el prompt (el host admite igual el adjunto
        // original). Sin duplicar en re-ejecuciones del hook.
        if (skipped.length > 0 && typeof input.prompt?.text === "string") {
          const marker = "H_ATFILE_SKIPPED"
          if (!input.prompt.text.includes(marker)) {
            const detail = skipped.map((s) => `${s.code}: ${s.uri}`).join("; ")
            input.prompt.text += `\n${marker}: ${skipped.length} attachment(s) admitted without anchors (${detail}).`
          }
        }
        // Auto-read (#19): lo mencionado en el texto con la misma clave que
        // los tools + resumen por mensaje de todo lo auto-servido. Sin
        // proyecto no hay claves relativas: solo adjuntos como antes.
        if (
          projectDir &&
          typeof input.prompt?.text === "string" &&
          !input.prompt.text.includes("H_AUTO_READ")
        ) {
          const attached: AutoServeSummary[] = []
          if (files) {
            for (let i = 0; i < files.length; i++) {
              if (!files[i] || files[i].uri === before[i]) continue
              let orig: string
              try {
                orig = toFsPath(before[i])
              } catch {
                continue
              }
              const rel = relativeKeyFor(projectDir, orig)
              if (rel === null) continue
              const rows = projStore.peek(orig)
              if (!rows) continue
              attached.push({ file: rel, lines: rows.length })
            }
          }
          const already = new Set(attached.map((a) => a.file))
          const { served } = await autoServeMentionedPaths(input.prompt.text, projectDir, projStore, already)
          const note = formatAutoReadNote(attached, served)
          if (note) input.prompt.text += note
        }
      } catch {
        // La admisión nunca se rompe por anotar.
      }
    })
    // Sin ctx.tool (stubs parciales de otros tickets) no hay tools que registrar.
    const cleanupTools = ctx.tool ? await registerCoreTools(ctx, { config: cfg, storeFor }) : undefined
    // Guardas nativas + system prompt; toleran stubs sin hook (tests de otros tickets).
    const cleanupGuards = ctx.tool ? await registerNativeGuards(ctx) : undefined
    return async () => {
      await cleanupGuards?.()
      await cleanupTools?.()
      for (const store of stores.values()) {
        try {
          store.close()
        } catch {
          // Cierre best-effort.
        }
      }
      stores.clear()
      await cleanupAtFile(atfile)
    }
  },
})
