import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const outputExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.node'])
const patterns = [
  /(\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"])(\.\.?\/[^'"]+)(['"])/g,
  /(\bimport\s*\(\s*['"])(\.\.?\/[^'"]+)(['"]\s*\))/g,
]

function emittedTarget(fromFile, specifier) {
  const target = resolve(fromFile, '..', specifier)
  if (existsSync(`${target}.js`) || existsSync(`${target}.d.ts`)) return `${specifier}.js`
  if (existsSync(join(target, 'index.js')) || existsSync(join(target, 'index.d.ts')))
    return `${specifier}/index.js`
  return undefined
}

export function rewriteSource(source, fromFile) {
  return patterns.reduce(
    (current, pattern) =>
      current.replace(pattern, (match, prefix, specifier, suffix) => {
        if (outputExtensions.has(extname(specifier))) return match
        const replacement = emittedTarget(fromFile, specifier)
        return replacement ? `${prefix}${replacement}${suffix}` : match
      }),
    source,
  )
}

function outputFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return outputFiles(path)
    return path.endsWith('.js') || path.endsWith('.d.ts') ? [path] : []
  })
}

export function rewriteDirectory(directory) {
  for (const path of outputFiles(directory)) {
    const source = readFileSync(path, 'utf8')
    const rewritten = rewriteSource(source, path)
    if (rewritten !== source) writeFileSync(path, rewritten)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  if (!directory) throw new Error('Usage: rewrite-esm-specifiers.mjs <output-directory>')
  rewriteDirectory(resolve(directory))
}
