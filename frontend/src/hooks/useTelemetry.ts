import { useEffect, useRef } from 'react'
import { api, type TelemetryQuery } from '../lib/api'
import { telemetryKey } from '../lib/opsSnapshots'
import { useOpsResource } from './useOpsResource'

/** Only one request at a time per selection. Changes abort and hide the old selection. */
export function useTelemetry(deviceId: string, query: TelemetryQuery, revision: unknown) {
  const { anchor } = query
  const state = useOpsResource(telemetryKey(deviceId, query), signal => api.opsTelemetry(deviceId, query, signal),
    anchor === 'live' ? 2000 : 30000, !!deviceId)
  const { refresh } = state
  // Push is invalidation only: stream values may include simulations.
  const lastPush = useRef(0)
  useEffect(() => {
    if (anchor === 'live' && revision && Date.now() - lastPush.current >= 1000) {
      lastPush.current = Date.now(); refresh()
    }
  }, [anchor, revision, refresh])
  return state
}
