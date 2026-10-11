// Bench manual único del ticket #16 (fase 2, calibración): mide serve-frío
// (ingest), re-serve con edición pequeña (align) y commit a 4096 anchors
// sobre el AnchorStore final de fase 2. Suelto a propósito: no es test, no
// corre en CI, no está cableado a package.json ni a tsconfig (include: src, test).
import { createAnchorStore } from "../src/anchor-store"

const N = 4096
const REPS = 5
const EDITED = 10

function linesUnique(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `const v${i} = ${i * 7 + 1}; // línea ${i} de relleno realista`)
}

function linesIdentical(n: number): string[] {
  return Array.from({ length: n }, () => "x")
}

// Edición pequeña determinista: cambia `count` líneas repartidas (rep k mueve
// el punto para que cada repetición realinee de verdad).
function editedVariant(base: string[], rep: number, count: number): string[] {
  const next = [...base]
  for (let k = 0; k < count; k++) {
    const i = (Math.floor(((k + 0.5) / count) * base.length) + rep) % base.length
    next[i] = `// editada r${rep}k${k} //////////////////////////////////////////////////`
  }
  return next
}

function stats(xs: number[]): { median: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b)
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const mid = Math.floor(s.length / 2)
  const median = s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
  return { median, mean }
}

function fmt(ms: number): string {
  return `${ms.toFixed(2)} ms`
}

function runShape(name: string, base: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  // ingest: store fresco por repetición (alloc completo de N anchors).
  const ingest: number[] = []
  for (let r = 0; r < REPS; r++) {
    const store = createAnchorStore({ sessionId: "bench", storePath: ":memory:" })
    const content = base.join("\n")
    const t0 = performance.now()
    const res = store.serve("bench.ts", content)
    ingest.push(performance.now() - t0)
    if (r === 0) {
      if (res.rows.length !== N) throw new Error(`ingest: ${res.rows.length} filas, esperaba ${N}`)
      if (new Set(res.rows.map((x) => x.anchor)).size !== N) throw new Error("ingest: anchors duplicados")
      if (res.warnings.length > 0) throw new Error(`ingest: warnings ${JSON.stringify(res.warnings)}`)
    }
    store.close()
  }
  // align: re-serve tibio sobre edición pequeña (reúso greedy de anchors).
  const storeA = createAnchorStore({ sessionId: "bench", storePath: ":memory:" })
  const before = storeA.serve("bench.ts", base.join("\n")).rows.map((x) => x.anchor)
  const align: number[] = []
  for (let r = 0; r < REPS; r++) {
    const content = editedVariant(base, r, EDITED).join("\n")
    const t0 = performance.now()
    const res = storeA.serve("bench.ts", content)
    align.push(performance.now() - t0)
    if (r === 0) {
      const kept = res.rows.filter((x, i) => x.anchor === before[i]).length
      console.log(`  [${name}] align: anchors conservados tras editar ${EDITED} líneas: ${kept}/${N}`)
    }
  }
  storeA.close()
  // commit: edición pequeña + commit (realign + persist).
  const storeC = createAnchorStore({ sessionId: "bench", storePath: ":memory:" })
  storeC.serve("bench.ts", base.join("\n"))
  const commit: number[] = []
  for (let r = 0; r < REPS; r++) {
    const content = editedVariant(base, r, EDITED).join("\n")
    const t0 = performance.now()
    const res = storeC.commit("bench.ts", content)
    commit.push(performance.now() - t0)
    if (r === 0 && res.rows.length !== N) throw new Error(`commit: ${res.rows.length} filas`)
  }
  storeC.close()
  for (const [op, xs] of Object.entries({ ingest, align, commit })) {
    const s = stats(xs)
    console.log(`  [${name}] ${op}: reps ${xs.map(fmt).join(" ")} | mediana ${fmt(s.median)} media ${fmt(s.mean)}`)
    out[op] = s.median
  }
  return out
}

const uniq = linesUnique(N)
const same = linesIdentical(N)
const bytesUniq = Buffer.byteLength(uniq.join("\n"), "utf-8")
console.log(`bench #16: N=${N} reps=${REPS} editadas=${EDITED} | contenido único ${bytesUniq} bytes (~${(bytesUniq / N).toFixed(0)} B/línea)`)
console.log(`forma "unique" (caso realista):`)
const a = runShape("unique", uniq)
console.log(`forma "identical" (peor caso del align greedy):`)
const b = runShape("identical", same)
console.log(JSON.stringify({ N, reps: REPS, bytesUnique: bytesUniq, unique_ms: a, identical_ms: b }))
