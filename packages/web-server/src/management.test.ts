import { describe, expect, it } from 'vitest'

import { parseMcpAddBody } from './management'

describe('parseMcpAddBody (WEB-EXT-MANAGE-MARKET-r1 §S3.3)', () => {
  it('maps stdio bodies to McpAddInput', () => {
    expect(
      parseMcpAddBody({
        action: 'add',
        name: 'files',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server'],
        env: { RUST_LOG: 'info' },
        scope: 'project',
      }),
    ).toEqual({
      name: 'files',
      scope: 'project',
      transport: { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { RUST_LOG: 'info' } },
    })
  })
  it("maps 'sse' to legacySse and keeps 'http' / 'streamable-http' on Streamable HTTP", () => {
    const sse = parseMcpAddBody({
      name: 'legacy',
      transport: 'sse',
      url: 'https://x/sse',
      headers: { Authorization: 'keyref://mcp.legacy.Authorization' },
    })
    expect(sse.transport).toEqual({
      kind: 'http',
      url: 'https://x/sse',
      headers: { Authorization: 'keyref://mcp.legacy.Authorization' },
      legacySse: true,
    })
    const http = parseMcpAddBody({ name: 'h', transport: 'http', url: 'https://x/mcp' })
    expect(http.transport).toEqual({ kind: 'http', url: 'https://x/mcp', headers: {} })
    const streamable = parseMcpAddBody({ name: 'h', transport: 'streamable-http', url: 'https://x' })
    expect('legacySse' in streamable.transport).toBe(false)
  })
  it('rejects invalid names / missing fields / wrong transport with web_schema_invalid', () => {
    const cases: Array<Record<string, unknown>> = [
      { name: '!bad', transport: 'http', url: 'u' },
      { transport: 'http', url: 'u' },
      { name: 'ok', transport: 'stdio' },
      { name: 'ok', transport: 'stdio', command: '' },
      { name: 'ok', transport: 'http' },
      { name: 'ok', transport: 'grpc', url: 'u' },
      { name: 'ok', transport: 'http', url: 'u', env: { a: 1 } },
    ]
    for (const body of cases) {
      let thrown: unknown
      try {
        parseMcpAddBody(body)
      } catch (error) {
        thrown = error
      }
      expect(thrown, JSON.stringify(body)).toMatchObject({ code: 'web_schema_invalid' })
    }
  })
})
