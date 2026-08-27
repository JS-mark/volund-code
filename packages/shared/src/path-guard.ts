import { lstat, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, parse, resolve, sep } from 'node:path'

import { VolundError } from './index'

function contains(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${sep}`)
}

export async function validateWorkspacePath(input: string): Promise<string> {
  const absolute = resolve(input)
  let canonical: string
  try {
    canonical = await realpath(absolute)
  } catch (cause) {
    throw new VolundError(
      'VOLUND_INVALID_CWD',
      `Workspace does not exist: ${input}`,
      { input },
      { cause },
    )
  }
  const home = await realpath(homedir())
  const root = parse(canonical).root
  const sensitive = [
    resolve(home, '.volund'),
    resolve(home, '.ssh'),
    ...(process.platform === 'win32' ? [] : ['/etc', '/private']),
  ]
  if (
    canonical === root ||
    canonical === home ||
    sensitive.some((prefix) => contains(prefix, canonical))
  ) {
    throw new VolundError('VOLUND_UNSAFE_CWD', `Refusing unsafe workspace: ${canonical}`, {
      input,
      canonical,
    })
  }
  if (isAbsolute(input)) {
    const [source, target] = await Promise.all([lstat(absolute), stat(canonical)])
    if (source.dev !== target.dev)
      throw new VolundError(
        'VOLUND_UNSAFE_CWD',
        `Workspace symlink crosses filesystems: ${input}`,
        { input, canonical },
      )
  }
  return canonical
}
