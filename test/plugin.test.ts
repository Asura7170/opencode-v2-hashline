import { describe, expect, test } from "bun:test"

import plugin from "../src/index"

// Costura: entry del plugin (spec #1). Solo id estable + setup; sin anchors/tools/hooks (tickets #3+).
describe("hashline plugin entry", () => {
  test("expone id estable opencode-hashline", () => {
    expect(plugin.id).toBe("opencode-hashline")
  })

  test("el id es estable entre recargas", async () => {
    const fresh = (await import(`../src/index?reload=${Date.now()}`)).default
    expect(fresh.id).toBe(plugin.id)
  })

  test("expone setup como funcion", () => {
    expect(typeof plugin.setup).toBe("function")
  })
})
