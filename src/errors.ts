import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'

export interface UpstreamErrorResult {
  status: number
  headers: IncomingHttpHeaders
  body: Readable
}

export class AllEndpointsInCooldownError extends Error {
  constructor(readonly modelName: string) {
    super(`All endpoints are currently in cooldown for model: ${modelName}`)
    this.name = 'AllEndpointsInCooldownError'
  }
}

export class AllEndpointsFailedError extends Error {
  constructor(
    readonly lastUpstreamResult: UpstreamErrorResult | null,
    readonly lastNetworkError: Error | null,
  ) {
    super('All endpoints failed')
    this.name = 'AllEndpointsFailedError'
  }
}
