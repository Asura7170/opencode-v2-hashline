import { describe, expect, test } from "bun:test"

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_CONFIG,
  globalConfigPath,
  loadHashlineConfig,
  projectConfigPath,
  resolveConfig,
  storePathFor,
} from "../src/config"
import { DEFAULT_EXCLUDES } from "../src/anchor-store"

// Costura: resolución de config (spec #1, historia 16) + cableado a tools.
// Precedencia: defaults < global < proyecto < opciones. Desconocidas rechazan.
describe("config defaults = límites del spec", () => {
  test("defaults replican los límites inline de #5", () => {
    expect(DEFAULT_CONFIG.maxOutputLines).toBe(2000)
    expect(DEFAULT_CONFIG.maxOutputBytes).toBe(50 * 1024)
    expect(DEFAULT_CONFIG.maxLineChars).toBe(2000)
    expect(DEFAULT_CONFIG.maxFileBytes).toBe(1_048_576)
    expect(DEFAULT_CONFIG.excludes).toEqual(DEFAULT_EXCLUDES)
  })

  test("storePathFor por defecto bajo <proyecto>/.opencode/hashline", () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-path-"))
    expect(storePathFor(dir, "sess-1")).toBe(join(dir, ".opencode", "hashline", "sess-1.sqlite"))
  })

  test("projectConfigPath vive junto al sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-path-"))
    expect(projectConfigPath(dir)).toBe(join(dir, ".opencode", "hashline", "config.json"))
  })

  test("globalConfigPath vive bajo home/.config/opencode/hashline", () => {
    expect(globalConfigPath("/home/u")).toBe(
      join("/home/u", ".config", "opencode", "hashline", "config.json"),
    )
  })
})

describe("config precedencia y sanitize", () => {
  test("global < proyecto < opciones", () => {
    const cfg = resolveConfig([
      { maxOutputLines: 10 },
      { maxOutputLines: 20, maxFileBytes: 100 },
      { maxOutputLines: 30 },
    ])
    expect(cfg.maxOutputLines).toBe(30)
    expect(cfg.maxFileBytes).toBe(100)
  })

  test("sin capas devuelve defaults", () => {
    expect(resolveConfig([])).toEqual(DEFAULT_CONFIG)
  })

  test("claves desconocidas se rechazan en cualquier capa", () => {
    expect(() => resolveConfig([{ nope: 1 } as any])).toThrow(/desconocida|E_INVALID_CONFIG/)
    expect(() => resolveConfig([{}, { otra: true } as any])).toThrow(/desconocida|E_INVALID_CONFIG/)
  })

  test("valores inválidos se rechazan", () => {
    expect(() => resolveConfig([{ maxOutputLines: 0 }])).toThrow(/E_INVALID_CONFIG/)
    expect(() => resolveConfig([{ maxOutputLines: 1.5 }])).toThrow(/E_INVALID_CONFIG/)
    expect(() => resolveConfig([{ excludes: "no-array" } as any])).toThrow(/E_INVALID_CONFIG/)
    expect(() => resolveConfig([{ maxFileBytes: -5 }])).toThrow(/E_INVALID_CONFIG/)
  })

  test("loadHashlineConfig: faltan archivos → defaults + opciones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-missing-"))
    const cfg = await loadHashlineConfig({
      projectDir: dir,
      globalPath: join(dir, "no-global.json"),
      projectPath: join(dir, "no-project.json"),
      options: { maxOutputLines: 5 },
    })
    expect(cfg.maxOutputLines).toBe(5)
    expect(cfg.maxFileBytes).toBe(DEFAULT_CONFIG.maxFileBytes)
  })

  test("loadHashlineConfig: global < proyecto < opciones desde disco", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-disk-"))
    const globalPath = join(dir, "global.json")
    const projectPath = join(dir, "project.json")
    writeFileSync(globalPath, JSON.stringify({ maxOutputLines: 10, maxFileBytes: 100 }))
    writeFileSync(projectPath, JSON.stringify({ maxOutputLines: 20 }))
    const cfg = await loadHashlineConfig({
      projectDir: dir,
      globalPath,
      projectPath,
      options: { maxOutputLines: 30 },
    })
    expect(cfg.maxOutputLines).toBe(30)
    expect(cfg.maxFileBytes).toBe(100)
    const withoutOptions = await loadHashlineConfig({ projectDir: dir, globalPath, projectPath })
    expect(withoutOptions.maxOutputLines).toBe(20)
    expect(withoutOptions.maxFileBytes).toBe(100)
  })

  test("loadHashlineConfig: clave desconocida en disco se rechaza", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-bad-"))
    const projectPath = join(dir, "project.json")
    writeFileSync(projectPath, JSON.stringify({ maxOutputLines: 20, nope: 1 }))
    await expect(
      loadHashlineConfig({ projectDir: dir, projectPath, globalPath: join(dir, "ng.json") }),
    ).rejects.toThrow(/desconocida|E_INVALID_CONFIG/)
  })

  test("loadHashlineConfig: JSON inválido se rechaza", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t9-json-"))
    const projectPath = join(dir, "project.json")
    writeFileSync(projectPath, "{no-json")
    await expect(
      loadHashlineConfig({ projectDir: dir, projectPath, globalPath: join(dir, "ng.json") }),
    ).rejects.toThrow(/E_INVALID_CONFIG/)
  })
})
