/**
 * 存储：单文件 JSON 库（data/market.json）+ 插件 bundle 落盘（data/bundles/）。
 * 规模上限由客户端契约决定（≤256 条/目录），单文件 JSON 足够；写操作经进程内
 * 串行队列 + 临时文件原子换名。升级路径：把 readDb/updateDb 换成 Postgres 实现，
 * 路由层不感知。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { seedDatabase, writeSeedBundles } from './seed'
import type { MarketDatabase } from './types'

export const dataRoot = () =>
  process.env.MARKET_DATA_DIR ? resolve(process.env.MARKET_DATA_DIR) : join(process.cwd(), 'data')
export const databaseFile = () => join(dataRoot(), 'market.json')
export const bundleRoot = () => join(dataRoot(), 'bundles')

let cache: MarketDatabase | undefined
let writeChain: Promise<unknown> = Promise.resolve()

async function loadDatabase(): Promise<MarketDatabase> {
  const file = databaseFile()
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const seeded = seedDatabase()
    await mkdir(dataRoot(), { recursive: true })
    await writeSeedBundles(bundleRoot(), seeded.bundleFiles)
    await writeFile(file, `${JSON.stringify(seeded.database, null, 2)}\n`, 'utf8')
    return seeded.database
  }
  return JSON.parse(raw) as MarketDatabase
}

/** 读库（进程内缓存；写操作后缓存即最新）。 */
export async function readDatabase(): Promise<MarketDatabase> {
  cache ??= await loadDatabase()
  return cache
}

/**
 * 串行化写事务：mutate 原地改库 → 原子落盘。mutate 抛错则不落盘，
 * 排队中的后续事务照常执行。
 */
export async function updateDatabase<T>(
  mutate: (database: MarketDatabase) => Promise<T> | T,
): Promise<T> {
  const run = async (): Promise<T> => {
    const database = await readDatabase()
    const result = await mutate(database)
    await mkdir(dataRoot(), { recursive: true })
    const temporary = `${databaseFile()}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, 'utf8')
    await rename(temporary, databaseFile())
    return result
  }
  const next = writeChain.then(run, run)
  writeChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/** 读取插件 bundle 内文件（路径已由调用方按 MarketFileSpec 校验）。 */
export async function readBundleFile(name: string, version: string, path: string): Promise<Buffer> {
  const root = join(bundleRoot(), name, version)
  const target = join(root, path)
  if (!target.startsWith(`${root}${sep}`)) throw new Error('bundle path escape')
  return readFile(target)
}

export async function writeBundleFiles(
  name: string,
  version: string,
  files: readonly { path: string; content: Buffer }[],
): Promise<void> {
  const root = join(bundleRoot(), name, version)
  for (const file of files) {
    const target = join(root, file.path)
    if (!target.startsWith(`${root}${sep}`)) throw new Error('bundle path escape')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content)
  }
}

export async function removeBundle(name: string): Promise<void> {
  await rm(join(bundleRoot(), name), { recursive: true, force: true })
}

export async function removeBundleVersion(name: string, version: string): Promise<void> {
  await rm(join(bundleRoot(), name, version), { recursive: true, force: true })
}
