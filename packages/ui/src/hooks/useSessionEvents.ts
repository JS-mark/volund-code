import type { CoreEvent, EventBus } from '@volund/core'
import { useEffect } from 'react'

export function useSessionEvents(
  events: EventBus | undefined,
  onEvent: (event: CoreEvent) => void,
) {
  useEffect(() => {
    if (!events) return
    return events.subscribe(onEvent)
  }, [events, onEvent])
}
