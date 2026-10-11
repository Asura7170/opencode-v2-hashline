import { AnchorStoreError } from "./anchor-store"

// Guardas sobre tools nativas (#6): strip idempotente de ecos `anchor│`
// en edits, echo-refusal estructurado en writes, aviso post-edit y
// system prompt vía hook de contexto. Sin store: la detección es por
// forma (`│` U+2502 casi nunca aparece en contenido real al inicio de
// línea tras 4 minúsculas), evitando acoplar served-record y efectos LRU.
// shortcut: colisión con contenido legítimo `aaaa│…` se stripearía;
// aceptable hasta que #10 lo verifique contra el binario.

// Única fuente de la forma de anchor (`│` U+2502 casi nunca aparece en
// contenido real al inicio de línea tras 4 minúsculas). Se comparte con
// atfile.ts; cada uso construye su RegExp fresca (sin `lastIndex` global
// compartido y frágil).
export const ANCHOR_SHAPE_SOURCE = "^[a-z]{4}│"

function echoRe(flags: "m" | "gm"): RegExp {
  return new RegExp(ANCHOR_SHAPE_SOURCE, flags)
}

export const SYSTEM_PROMPT_MARKER = "hashline anchors:"

export const SYSTEM_PROMPT = [
  "hashline anchors: `read` serves `anchor│content` rows; anchors are 4-letter, allocated per line and stable across edits of untouched lines — reference anchors, never line numbers.",
  "Edit via hashline tools: `replace` (startAnchor/endAnchor + content), `insert` (anchor + before/after + content); every edit returns a diff with live anchors. `undo_last_change` reverts one batch per file.",
  "Never paste `anchor│` prefixes into native tools: native `edit` strips them (with an H_ECHO_STRIPPED notice); native `write` containing them fails with E_ANCHOR_ECHO — use the hashline tools instead.",
  "Stale anchors fail with E_ANCHOR_STALE plus current rows: re-read and retry. Identical rewrites report H_NOOP without writing.",
].join("\n")

// Host mínimo que usan las guardas: tolera stubs parciales (tests) y el
// Context real del plugin. Los callbacks infieren sus eventos de aquí,
// no de `any`.
export interface GuardToolEvent {
  tool?: unknown
  input?: unknown
  id?: unknown
  status?: unknown
  result?: unknown
}

export interface GuardSessionInput {
  system?: unknown
}

export interface GuardHost {
  tool?: {
    hook: (
      name: "execute.before" | "execute.after",
      cb: (ev: GuardToolEvent) => void | Promise<void>,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
  session?: {
    hook: (
      name: "context",
      cb: (input: GuardSessionInput) => void | Promise<void>,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
}

// Tools propias: el wrapper codemode `execute` también dispara hooks,
// así que se omiten por nombre (además el strip ya es idempotente).
const OWN_TOOLS = new Set(["read", "replace", "insert", "undo_last_change"])

export function stripEchoedAnchors(text: string): { text: string; stripped: number } {
  let stripped = 0
  const out = text.replace(echoRe("gm"), () => {
    stripped++
    return ""
  })
  return { text: out, stripped }
}

function countEchoes(text: string): number {
  const re = echoRe("gm")
  let n = 0
  while (re.exec(text) !== null) n++
  return n
}

// Único recorrido recursivo del input (JSON-ish): cada string pasa por el
// visitor con setter para mutar in-place. strip/has/count lo reutilizan en
// vez de triplicar la recursión.
function eachString(
  input: unknown,
  visit: (value: string, set: (next: string) => void) => void,
): void {
  if (typeof input === "string") {
    visit(input, () => {})
    return
  }
  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      const v = input[i]
      if (typeof v === "string") {
        const at = i
        visit(v, (next) => {
          input[at] = next
        })
      } else if (v !== null && typeof v === "object") {
        eachString(v, visit)
      }
    }
    return
  }
  if (input !== null && typeof input === "object") {
    for (const k of Object.keys(input)) {
      const v = (input as Record<string, unknown>)[k]
      if (typeof v === "string") {
        visit(v, (next) => {
          ;(input as Record<string, unknown>)[k] = next
        })
      } else if (v !== null && typeof v === "object") {
        eachString(v, visit)
      }
    }
  }
}

// Recorre el input (JSON-ish) mutando strings in-place; devuelve ecos.
export function stripEchoesInInput(input: unknown): number {
  let n = 0
  eachString(input, (v, set) => {
    if (typeof v !== "string") return
    const r = stripEchoedAnchors(v)
    if (r.stripped > 0) {
      set(r.text)
      n += r.stripped
    }
  })
  return n
}

export function hasEchoesInInput(input: unknown): boolean {
  let found = false
  eachString(input, (v) => {
    if (!found && typeof v === "string" && echoRe("m").test(v)) found = true
  })
  return found
}

function countEchoesInInput(input: unknown): number {
  let n = 0
  eachString(input, (v) => {
    if (typeof v === "string") n += countEchoes(v)
  })
  return n
}

export async function registerNativeGuards(ctx: GuardHost): Promise<() => void> {
  const disposers: { dispose: () => Promise<void> }[] = []
  // id de call → ecos limpiados en before, para avisar en after.
  const pending = new Map<string, number>()

  if (ctx.tool?.hook) {
    disposers.push(
      await ctx.tool.hook("execute.before", (ev) => {
        // El refusal debe atravesar: se decide fuera del try que protege al host.
        if (
          typeof ev?.tool === "string" &&
          !OWN_TOOLS.has(ev.tool) &&
          ev.tool === "write" &&
          hasEchoesInInput(ev?.input)
        ) {
          const n = countEchoesInInput(ev.input)
          throw new AnchorStoreError(
            "E_ANCHOR_ECHO",
            `Native write recibió ${n} línea(s) con prefijos anchor ("aaaa│…"); ` +
              `rechazado para no corromper el archivo. Usa replace/insert con anchors pelados, o quita los prefijos.`,
          )
        }
        try {
          if (typeof ev?.tool !== "string" || OWN_TOOLS.has(ev.tool) || ev.tool !== "edit") return
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
      // Post-edit solo avisa strips propios: no anota lecturas (el override
      // de `read` ya sirve anchors; #6).
      await ctx.tool.hook("execute.after", (ev) => {
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
      await ctx.session.hook("context", (input) => {
        try {
          const sys = input?.system
          if (!Array.isArray(sys)) return
          if (
            sys.some(
              (p: unknown) =>
                typeof p === "object" &&
                p !== null &&
                "text" in p &&
                typeof p.text === "string" &&
                p.text.includes(SYSTEM_PROMPT_MARKER),
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
