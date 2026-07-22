import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import type { Protocol } from './types.js'

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

export class ProtocolNotSupportedError extends Error {
  constructor(
    readonly modelName: string,
    readonly protocol: Protocol,
  ) {
    super(`No endpoints support ${protocol} protocol for model: ${modelName}`)
    this.name = 'ProtocolNotSupportedError'
  }
}

export class RequestAdaptationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestAdaptationError'
  }
}
