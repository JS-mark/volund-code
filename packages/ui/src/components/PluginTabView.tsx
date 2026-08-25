import { Box, Text } from 'ink'

import type { PluginStatusTab, PluginStatusTabError } from '../status'
import { StatusHeatmap } from './StatusHeatmap'

export interface PluginTabViewProps {
  tab: PluginStatusTab | PluginStatusTabError
  /** 终端列宽，传给 heatmap 体例。 */
  columns: number
}

/**
 * PLUGIN-STATUS-UI-r1：插件贡献页签的 K0 渲染器。描述符已在传入前过
 * sanitizePluginTabs（§S3.3），这里的一切值都当纯文本渲染。
 */
export function PluginTabView({ tab, columns }: PluginTabViewProps) {
  if ('error' in tab)
    return (
      <Box flexDirection="column" minHeight={3}>
        <Text dimColor>section error: {tab.label}</Text>
      </Box>
    )
  const body = tab.body
  if (body.kind === 'rows')
    return (
      <Box flexDirection="column" minHeight={3}>
        {body.sections.map((section, sectionIndex) => (
          <Box
            flexDirection="column"
            key={section.title ?? sectionIndex}
            marginTop={sectionIndex > 0 ? 1 : 0}
          >
            {section.title ? <Text bold>{section.title}</Text> : null}
            {section.rows.map(([label, value], rowIndex) => (
              <Box key={`${label}-${rowIndex}`}>
                <Box width={24}>
                  <Text dimColor>{label}</Text>
                </Box>
                <Text wrap="truncate-end">{value}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  if (body.kind === 'heatmap')
    return (
      <StatusHeatmap
        columns={columns}
        heatmap={body.heatmap}
        {...(body.legend ? { legend: body.legend } : {})}
      />
    )
  // table 体例：受限多列表（≤4 列已由 sanitize 保证）
  const widths = body.columns.map((column, columnIndex) =>
    Math.min(
      32,
      Math.max(column.length, ...body.rows.map((row) => (row[columnIndex] ?? '').length)) + 2,
    ),
  )
  return (
    <Box flexDirection="column" minHeight={3}>
      <Box>
        {body.columns.map((column, columnIndex) => (
          <Box key={columnIndex} width={widths[columnIndex]}>
            <Text bold wrap="truncate-end">
              {column}
            </Text>
          </Box>
        ))}
      </Box>
      {body.rows.map((row, rowIndex) => (
        <Box key={rowIndex}>
          {body.columns.map((_, columnIndex) => (
            <Box key={columnIndex} width={widths[columnIndex]}>
              <Text wrap="truncate-end">{row[columnIndex] ?? ''}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}
