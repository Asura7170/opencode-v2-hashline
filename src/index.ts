import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Plugin } from "@opencode/plugin"

import { type AnchorStore, createAnchorStore } from "./anchor-store"
import { annotateAttachments, cleanupAtFile, createAtFileState } from "./atfile"
import {
  loadHashlineConfig,
  storePathFor,
  withProjectKeys,
  type HashlineConfig,
} from "./config"
import { registerCoreTools } from "./core-tools"
import { registerNativeGuards } from "./native-guards"

function projectDirOf(ctx: any): string | null {
  const dir = ctx.location?.project?.directory ?? ctx.location?.directory
  return typeof dir === "string" && dir !== "" ? dir : null
}

function openStore(projectDir: string | null, sessionID: string, cfg: HashlineConfig): AnchorStore {
  if (projectDir === null) {
    // Sin proyecto (ctx parcial en tests): tmpdir como antes, con límites de la config.
    const safe = sessionID.replace(/[^A-Za-z0-9._-]+/g, "_")
    return createAnchorStore({
      sessionId: sessionID,
      storePath: join(tmpdir(), `opencode-hashline-${safe}.sqlite`),
      maxFileBytes: cfg.maxFileBytes,
      maxAnchors: cfg.maxAnchors,
      excludes: cfg.excludes,
    })
  }
  // Sidecar canónico keyeado por proyecto+sesión, compartido por admisión y tools.
  const storePath = storePathFor(projectDir, sessionID, cfg.storeDir)
  mkdirSync(dirname(storePath), { recursive: true })
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
        await annotateAttachments(
          input.prompt.files as { uri: string }[] | undefined,
          projectDir ? withProjectKeys(store, projectDir) : store,
          atfile,
        )
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
