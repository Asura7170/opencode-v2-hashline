// Root entrypoint re-export: the v2 directory loader only resolves a root
// `index.*` and ignores package.json `main`/`exports` (upstream #52300).
export { default } from "./src/index"
