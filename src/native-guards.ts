import { AnchorStoreError } from "./anchor-store"

// Guardas sobre tools nativas (#6): strip idempotente de ecos `anchor│`
// en edits, echo-refusal estructurado en writes, aviso post-edit y
// system prompt vía hook de contexto. Sin store: la detección es por
// forma (`│` U+2502 casi nunca aparece en contenido real al inicio de
// línea tras 4 minúsculas), evitando acoplar served-record y efectos LRU.
// shortcut: colisión con contenido legítimo `aaaa│…` se stripearía;
// aceptable hasta que #10 lo verifique contra el binario.

const ECHO_RE = /^[a-z]{4}│/gm
const ECHO_TEST = /^[a-z]{4}│/m

export const SYSTEM_PROMPT_MARKER = "hashline anchors:"

export const SYSTEM_PROMPT = [
  "hashline anchors: `read` serves `anchor│content` rows; anchors are 4-letter, allocated per line and stable across edits of untouched lines — reference anchors, never line numbers.",
  "Edit via hashline tools: `replace` (startAnchor/endAnchor + content), `insert` (anchor + before/after + content); every edit returns a diff with live anchors. `undo_last_change` reverts one batch per file.",
  "Never paste `anchor│` prefixes into native tools: native `edit` strips them (with an H_ECHO_STRIPPED notice); native `write` containing them fails with E_ANCHOR_ECHO — use the hashline tools instead.",
  "Stale anchors fail with E_ANCHOR_STALE plus current rows: re-read and retry. Identical rewrites report H_NOOP without writing.",
].join("\n")

// Tools propias: el wrapper codemode `execute` también dispara hooks,
// así que se omiten por nombre (además el strip ya es idempotente).
const OWN_TOOLS = new Set(["read", "replace", "insert", "undo_last_change"])

export function stripEchoedAnchors(text: string): { text: string; stripped: number } {
  let stripped = 0
  const out = text.replace(ECHO_RE, () => {
    stripped++
    return ""
  })
  return { text: out, stripped }
}

function countEchoes(text: string): number {
  ECHO_RE.lastIndex = 0
  let n = 0
  while (ECHO_RE.exec(text) !== null) n++
  return n
}

// Recorre el input (JSON-ish) mutando strings in-place; devuelve ecos.
export function stripEchoesInInput(input: unknown): number {
  if (Array.isArray(input)) {
    let n = 0
    for (let i = 0; i < input.length; i++) {
      const v = input[i]
      if (typeof v === "string") {
        const r = stripEchoedAnchors(v)
        if (r.stripped > 0) {
          input[i] = r.text
          n += r.stripped
        }
      } else if (v !== null && typeof v === "object") {
        n += stripEchoesInInput(v)
      }
    }
    return n
  }
  if (input !== null && typeof input === "object") {
    let n = 0
    for (const k of Object.keys(input)) {
      const v = (input as Record<string, unknown>)[k]
      if (typeof v === "string") {
        const r = stripEchoedAnchors(v)
        if (r.stripped > 0) {
          ;(input as Record<string, unknown>)[k] = r.text
          n += r.stripped
        }
      } else if (v !== null && typeof v === "object") {
        n += stripEchoesInInput(v)
      }
    }
    return n
  }
  return 0
}

export function hasEchoesInInput(input: unknown): boolean {
  if (typeof input === "string") {
    ECHO_TEST.lastIndex = 0
    return ECHO_TEST.test(input)
  }
  if (Array.isArray(input)) return input.some(hasEchoesInInput)
  if (input !== null && typeof input === "object") {
    return Object.values(input).some(hasEchoesInInput)
  }
  return false
}

function countEchoesInInput(input: unknown): number {
  if (typeof input === "string") return countEchoes(input)
  if (Array.isArray(input)) return input.reduce<number>((n, v) => n + countEchoesInInput(v), 0)
  if (input !== null && typeof input === "object") {
    return Object.values(input).reduce<number>((n, v) => n + countEchoesInInput(v), 0)
  }
  return 0
}

export async function registerNativeGuards(ctx: any): Promise<() => void> {
  const disposers: { dispose: () => Promise<void> }[] = []
  // id de call → ecos limpiados en before, para avisar en after.
  const pending = new Map<string, number>()

  if (ctx.tool?.hook) {
    disposers.push(
      await ctx.tool.hook("execute.before", (ev: any) => {
        // El refusal debe atravesar: se decide fuera del try que protege al host.
        if (!OWN_TOOLS.has(ev?.tool) && ev?.tool === "write" && hasEchoesInInput(ev?.input)) {
          const n = countEchoesInInput(ev.input)
          throw new AnchorStoreError(
            "E_ANCHOR_ECHO",
            `Native write recibió ${n} línea(s) con prefijos anchor ("aaaa│…"); ` +
              `rechazado para no corromper el archivo. Usa replace/insert con anchors pelados, o quita los prefijos.`,
          )
        }
        try {
          if (OWN_TOOLS.has(ev?.tool) || ev?.tool !== "edit") return
          const n = stripEchoesInInput(ev?.input)
          if (n > 0 && typeof ev?.id === "string") {
            pending.set(ev.id, (pending.get(ev.id) ?? 0) + n)
          }
        } catch {
          // Las guardas nunca rompen la ejecución del host.
        }
      }),
    )
    disposers.push(
      await ctx.tool.hook("execute.after", (ev: any) => {
        try {
          const n = typeof ev?.id === "string" ? pending.get(ev.id) : undefined
          if (typeof ev?.id === "string") pending.delete(ev.id)
          if (!n || ev?.status !== "completed" || !ev?.result) return
          const note =
            `H_ECHO_STRIPPED: ${n} echoed anchor prefix(es) stripped before the native edit; ` +
            `content applied without them.`
          const content = (ev.result as { content?: unknown }).content
          if (typeof content === "string") {
            ;(ev.result as { content: string }).content = `${content}\n${note}`
          } else if (Array.isArray(content)) {
            content.push({ type: "text", text: note })
          }
        } catch {
          // Las guardas nunca rompen la ejecución del host.
        }
      }),
    )
  }

  if (ctx.session?.hook) {
    disposers.push(
      await ctx.session.hook("context", (input: any) => {
        try {
          const sys = input?.system
          if (!Array.isArray(sys)) return
          if (
            sys.some(
              (p: any) => typeof p?.text === "string" && p.text.includes(SYSTEM_PROMPT_MARKER),
            )
          ) {
            return
          }
          sys.push({ type: "text", text: SYSTEM_PROMPT })
        } catch {
          // El contexto nunca se rompe por el prompt.
        }
      }),
    )
  }

  return async () => {
    for (const d of disposers) {
      try {
        await d.dispose()
      } catch {
        // Cierre best-effort.
      }
    }
  }
}
