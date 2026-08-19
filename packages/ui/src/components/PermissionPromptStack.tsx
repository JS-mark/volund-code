import { Box, Text, useInput } from 'ink'

import type {
  InteractivePermissionDecisionKind,
  InteractivePermissionRequest,
  PermissionPromptController,
} from '../permission'

export interface PermissionPromptStackProps {
  controller: PermissionPromptController
  requests: readonly InteractivePermissionRequest[]
}

export function PermissionPromptStack({ controller, requests }: PermissionPromptStackProps) {
  const request = requests[0]
  useInput(
    (input) => {
      if (!request) return
      const decision = decisionForInput(input)
      if (!decision) return
      if (!request.display.approvable && decision !== 'deny') return
      controller.decide(request.id, { kind: decision })
    },
    { isActive: Boolean(request) },
  )

  if (!request) return null

  return (
    <Box
      borderColor="yellow"
      borderStyle="single"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text color="yellow" bold>
        Permission required: {request.display.toolName}
      </Text>
      <Text color="gray" wrap="wrap">
        {request.display.spec}
      </Text>
      <Text>
        {request.display.approvable ? (
          <>
            <Text color="green" bold>
              a
            </Text>{' '}
            allow once{' '}
            <Text color="cyan" bold>
              s
            </Text>{' '}
            allow session{' '}
          </>
        ) : null}
        <Text color="red" bold>
          d
        </Text>{' '}
        deny
      </Text>
      {requests.length > 1 ? <Text color="gray">{requests.length - 1} queued</Text> : null}
    </Box>
  )
}

function decisionForInput(input: string): InteractivePermissionDecisionKind | undefined {
  if (input === 'a') return 'allow-once'
  if (input === 's') return 'allow-session'
  if (input === 'd') return 'deny'
}
