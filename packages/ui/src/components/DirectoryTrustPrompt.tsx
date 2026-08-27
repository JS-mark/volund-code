import { productIdentity } from '@volund/shared'
import { Box, Text } from 'ink'

import { SelectList } from './SelectList'

export type DirectoryTrustDecision = 'current' | 'parent' | 'tree' | 'exit'

export interface DirectoryTrustPromptProps {
  canonicalPath: string
  parentPath: string
  onDecision: (decision: DirectoryTrustDecision) => void
}

function isDirectoryTrustDecision(value: string): value is DirectoryTrustDecision {
  return value === 'current' || value === 'parent' || value === 'tree' || value === 'exit'
}

export function DirectoryTrustPrompt({
  canonicalPath,
  parentPath,
  onDecision,
}: DirectoryTrustPromptProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Do you trust the files in this folder?
      </Text>
      <Text>{canonicalPath}</Text>
      <Text color="gray">
        {productIdentity.shortName} may read, write, or execute files here. Directory trust only
        allows startup; normal permission and sandbox checks still apply.
      </Text>
      <SelectList
        items={[
          {
            id: 'current',
            label: 'Trust this folder only',
            description: `exact: ${canonicalPath}`,
          },
          { id: 'parent', label: 'Trust parent folder tree', description: `tree: ${parentPath}` },
          {
            id: 'tree',
            label: 'Trust folder and subdirectories',
            description: `tree: ${canonicalPath}`,
          },
          { id: 'exit', label: 'No, exit', description: 'start nothing' },
        ]}
        onCancel={() => onDecision('exit')}
        onSubmit={(id) => {
          if (isDirectoryTrustDecision(id)) onDecision(id)
        }}
      />
      <Text color="gray">↑/↓ select · Enter confirm · Esc exit</Text>
    </Box>
  )
}
