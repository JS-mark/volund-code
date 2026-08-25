import { Box, Text } from 'ink'

import { heatmapLevel } from '../status'

/** 热力图 1-4 档的橙色系（对齐 Less→More 色带；0 档渲染为灰点）。 */
export const HEATMAP_COLORS = ['#5c2d12', '#8f4a1d', '#c96f2e', '#f08c3c'] as const
const WEEKDAY_LABELS = ['   ', 'Mon', '   ', 'Wed', '   ', 'Fri', '   '] as const
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

export interface StatusHeatmapProps {
  /** start 是周日（YYYY-MM-DD），days[i] 是 start+i 天的计数。 */
  heatmap: { start: string; days: readonly number[] }
  /** 终端列宽，用于截断到可视周数。 */
  columns: number
  /** 图例行右侧文字；缺省渲染标准 Less→More。 */
  legend?: string
}

/**
 * GitHub 风格日粒度热力图。Stats 页签与插件贡献页签（PLUGIN-STATUS-UI-r1
 * heatmap 体例）共用的 K0 渲染器。
 */
export function StatusHeatmap({ heatmap, columns, legend }: StatusHeatmapProps) {
  const weeksTotal = Math.ceil(heatmap.days.length / 7)
  // 每列 2 字符 + 左侧 4 字符星期标签 + PanelFrame paddingX(1)×2。
  const visibleWeeks = Math.max(4, Math.min(weeksTotal, Math.floor((columns - 8) / 2)))
  const firstWeek = weeksTotal - visibleWeeks
  const maxCount = heatmap.days.reduce((max, count) => Math.max(max, count), 0)
  const weeks = Array.from({ length: visibleWeeks }, (_, index) => firstWeek + index)

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{monthLabelRow(heatmap.start, firstWeek, visibleWeeks)}</Text>
      {WEEKDAY_LABELS.map((weekday, dayOfWeek) => (
        <Box key={dayOfWeek}>
          <Text dimColor>{weekday} </Text>
          {weeks.map((week) => {
            const dayIndex = week * 7 + dayOfWeek
            if (dayIndex >= heatmap.days.length) return <Text key={week}>{'  '}</Text>
            const level = heatmapLevel(heatmap.days[dayIndex] ?? 0, maxCount)
            if (level === 0)
              return (
                <Text dimColor key={week}>
                  ·{' '}
                </Text>
              )
            return (
              <Text backgroundColor={HEATMAP_COLORS[level - 1] ?? '#5c2d12'} key={week}>
                {'  '}
              </Text>
            )
          })}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>{'    Less '}</Text>
        {HEATMAP_COLORS.map((color) => (
          <Text backgroundColor={color} key={color}>
            {'  '}
          </Text>
        ))}
        <Text dimColor> More{legend ? `  ${legend}` : ''}</Text>
      </Box>
    </Box>
  )
}

/**
 * 月份标签行：某周首日相对上一可见周换了月份，就在该列上方印 3 字母月名；
 * 行尾 3 列内或与上一标签重叠时不印（宁可缺一个标签也不挤出折行）。
 */
function monthLabelRow(start: string, firstWeek: number, visibleWeeks: number): string {
  const width = 4 + visibleWeeks * 2
  const chars = Array.from({ length: width }, () => ' ')
  let previousMonth = -1
  let labelEnd = 0
  const [year = 1970, month = 1, date = 1] = start.split('-').map(Number)
  const first = new Date(year, month - 1, date)
  for (let week = 0; week < visibleWeeks; week += 1) {
    const day = new Date(
      first.getFullYear(),
      first.getMonth(),
      first.getDate() + (firstWeek + week) * 7,
    )
    const monthIndex = day.getMonth()
    if (monthIndex === previousMonth) continue
    const position = 4 + week * 2
    if (position < labelEnd || position + 3 > width) continue
    const label = MONTH_LABELS[monthIndex]!
    for (let index = 0; index < 3; index += 1) chars[position + index] = label[index]!
    previousMonth = monthIndex
    labelEnd = position + 3
  }
  return chars.join('')
}
