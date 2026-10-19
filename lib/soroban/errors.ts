/**
 * Stable categories exposed to user interfaces and support tooling.
 * Raw provider and contract messages are intentionally not returned to users.
 */
export type TrellisErrorCode =
  | 'TX_CANCELLED'
  | 'SIMULATION_FAILED'
  | 'INSUFFICIENT_BALANCE'
  | 'UNAUTHORIZED'
  | 'VALIDATION_FAILED'
  | 'NETWORK_UNAVAILABLE'
  | 'UNEXPECTED_ERROR'

export interface ErrorGuidance {
  message: string
  remediation: string
  retryable: boolean
}

export const USER_SAFE_ERROR_CATALOG: Readonly<Record<TrellisErrorCode, ErrorGuidance>> = {
  TX_CANCELLED: {
    message: 'Transaction cancelled. Review the details and approve it when you are ready.',
    remediation: 'No transaction was submitted. Start again and approve the wallet prompt if you want to continue.',
    retryable: false,
  },
  SIMULATION_FAILED: {
    message: 'This transaction cannot be completed with the current details. Review the values and try again.',
    remediation: 'Check the amount, account permissions, and current network state. Correct any invalid details before retrying.',
    retryable: true,
  },
  INSUFFICIENT_BALANCE: {
    message: 'Your wallet does not have enough funds to complete this transaction.',
    remediation: 'Add the required asset and enough native token for network fees, then submit the transaction again.',
    retryable: false,
  },
  UNAUTHORIZED: {
    message: 'You are not authorized to perform this action. Reconnect your wallet and try again.',
    remediation: 'Reconnect the intended wallet account and verify it has the required role or permission. Do not retry until access is corrected.',
    retryable: false,
  },
  VALIDATION_FAILED: {
    message: 'Some transaction details are invalid. Review the highlighted values and try again.',
    remediation: 'Correct the invalid or missing fields and confirm the selected network and asset before submitting again.',
    retryable: false,
  },
  NETWORK_UNAVAILABLE: {
    message: 'We could not reach the network. Check your connection and try again.',
    remediation: 'Check connectivity and service status, then retry. Before replaying a submitted transaction, check its status to avoid a duplicate.',
    retryable: true,
  },
  UNEXPECTED_ERROR: {
    message: 'We could not complete this action. Try again shortly, then contact support with the reference ID if it persists.',
    remediation: 'Check the operation status before retrying in case it was already accepted. If it persists, contact support with the reference ID.',
    retryable: true,
  },
}

export interface UserSafeError {
  code: TrellisErrorCode
  message: string
  remediation: string
  retryable: boolean
  correlationId: string
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = error.message
    if (typeof message === 'string') return message
  }
  return ''
}

function errorProperty(error: unknown, property: string): unknown {
  if (typeof error !== 'object' || error === null || !(property in error)) return undefined
  return Reflect.get(error, property)
}

function mappedCode(error: unknown): TrellisErrorCode | undefined {
  const code = errorProperty(error, 'code')
  if (typeof code !== 'string') return undefined

  switch (code.toUpperCase()) {
    case 'TX_CANCELLED':
      return 'TX_CANCELLED'
    case 'SIMULATION_FAILED':
    case 'CONTRACT_REVERTED':
      return 'SIMULATION_FAILED'
    case 'INSUFFICIENT_BALANCE':
    case 'INSUFFICIENT_FUNDS':
      return 'INSUFFICIENT_BALANCE'
    case 'UNAUTHORIZED':
      return 'UNAUTHORIZED'
    case 'VALIDATION_FAILED':
      return 'VALIDATION_FAILED'
    case 'NETWORK_UNAVAILABLE':
    case 'NETWORK_ERROR':
      return 'NETWORK_UNAVAILABLE'
    case 'UNEXPECTED_ERROR':
    case 'UNKNOWN_ERROR':
      return 'UNEXPECTED_ERROR'
    default:
      return undefined
  }
}

function createCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `trellis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Maps wallet, network, and contract failures to stable product-facing data.
 * The original error should only be logged in a protected diagnostic context.
 */
export function toUserSafeError(error: unknown, correlationId = createCorrelationId()): UserSafeError {
  const message = errorMessage(error).toLowerCase()
  const response = errorProperty(error, 'response')
  const status =
    errorProperty(error, 'status') ??
    errorProperty(error, 'statusCode') ??
    errorProperty(response, 'status')
  const code = mappedCode(error)

  let resolvedCode: TrellisErrorCode

  if (code) {
    resolvedCode = code
  } else if (message.includes('user rejected') || message.includes('user declined')) {
    resolvedCode = 'TX_CANCELLED'
  } else if (message.includes('insufficient balance') || message.includes('underfunded')) {
    resolvedCode = 'INSUFFICIENT_BALANCE'
  } else if (
    status === 401 ||
    status === 403 ||
    message.includes('unauthorized') ||
    message.includes('not authorized') ||
    message.includes('authentication') ||
    message.includes('permission denied')
  ) {
    resolvedCode = 'UNAUTHORIZED'
  } else if (message.includes('invalid') || message.includes('validation')) {
    resolvedCode = 'VALIDATION_FAILED'
  } else if (message.includes('simulation failed') || message.includes('contract reverted')) {
    resolvedCode = 'SIMULATION_FAILED'
  } else if (
    status === 429 ||
    (typeof status === 'number' && status >= 500) ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('fetch')
  ) {
    resolvedCode = 'NETWORK_UNAVAILABLE'
  } else {
    resolvedCode = 'UNEXPECTED_ERROR'
  }

  return {
    code: resolvedCode,
    ...USER_SAFE_ERROR_CATALOG[resolvedCode],
    correlationId,
  }
}

/**
 * Backwards-compatible helper for existing call sites that only render text.
 */
export function getHumanReadableError(error: unknown): string {
  return toUserSafeError(error).message
}

/** Common Soroban error-code families for low-level diagnostics. */
export const SOROBAN_ERROR_CODES = {
  CONTRACT_ERR: 1,
  HOST_ERR: 2,
  AUTH_ERR: 3,
} as const