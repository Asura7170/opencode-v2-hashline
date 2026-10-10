import { tmpdir } from "node:os"
import { join } from "node:path"

import { Plugin } from "@opencode/plugin"

import { type AnchorStore, createAnchorStore } from "./anchor-store"
import { annotateAttachments, cleanupAtFile, createAtFileState } from "./atfile"
import { registerCoreTools } from "./core-tools"
import { registerNativeGuards } from "./native-guards"

export default Plugin.define({
  id: "opencode-hashline",
  async setup(ctx) {
    const atfile = createAtFileState()
    // Un store por sesión; sidecar keyeado por proyecto+sesión (location del ctx).
    // shortcut: ruta en tmpdir hasta que #9 (config) la haga tunable.
    const stores = new Map<string, AnchorStore>()
    const storeFor = (sessionID: string): AnchorStore => {
      let store = stores.get(sessionID)
      if (!store) {
        const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_")
        store = createAnchorStore({
          sessionId: sessionID,
          storePath: join(tmpdir(), `opencode-hashline-${safe(ctx.location.project.id)}-${safe(sessionID)}.sqlite`),
        })
        stores.set(sessionID, store)
      }
      return store
    }
    await ctx.session.hook("prompt", async (input) => {
      try {
        await annotateAttachments(input.prompt.files as { uri: string }[] | undefined, storeFor(input.sessionID), atfile)
      } catch {
        // La admisión nunca se rompe por anotar.
      }
    })
    // Sin ctx.tool (stubs parciales de otros tickets) no hay tools que registrar.
    const cleanupTools = ctx.tool ? await registerCoreTools(ctx) : undefined
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
