import { api } from './api'
import { loadPresentation, presentDevices, presentMap, presentationSeries } from './presentation'

// Read-only presentation adapter. Ops/auth/writes retain the original API.
export const presentationApi = {
  ...api,
  devices: async () => {
    const [live, saved] = await Promise.all([api.devices(), loadPresentation()])
    return presentDevices(live, saved)
  },
  mapOverview: async () => {
    const [live, saved] = await Promise.all([api.mapOverview(), loadPresentation()])
    return presentMap(live, saved)
  },
  series: async (deviceId: string, days: number) => {
    const scene = (await loadPresentation())?.scenes.find(s => s.device.device_id === deviceId)
    return scene ? presentationSeries(scene, days) : api.series(deviceId, days)
  },
}
