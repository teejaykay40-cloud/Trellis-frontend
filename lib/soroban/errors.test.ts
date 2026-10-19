import { toUserSafeError, USER_SAFE_ERROR_CATALOG } from './errors'

describe('toUserSafeError', () => {
  it('keeps wallet cancellation stable and does not suggest an automatic retry', () => {
    const result = toUserSafeError(new Error('User rejected the request'), 'support-1')

    expect(result).toMatchObject({
      code: 'TX_CANCELLED',
      retryable: false,
      correlationId: 'support-1',
    })
    expect(result.remediation).toContain('No transaction was submitted')
  })

  it('classifies authorization failures without exposing provider details', () => {
    const result = toUserSafeError({
      response: { status: 403 },
      message: 'internal role service response',
    })

    expect(result.code).toBe('UNAUTHORIZED')
    expect(result.retryable).toBe(false)
    expect(result.message).not.toContain('internal role service')
    expect(result.remediation).toContain('required role or permission')
  })

  it('maps structured cross-repository error codes without changing their legacy values', () => {
    expect(toUserSafeError({ code: 'INSUFFICIENT_FUNDS' }).code).toBe('INSUFFICIENT_BALANCE')
    expect(toUserSafeError({ code: 'CONTRACT_REVERTED' }).code).toBe('SIMULATION_FAILED')
    expect(toUserSafeError({ code: 'VALIDATION_FAILED' }).code).toBe('VALIDATION_FAILED')
  })

  it('marks transient network and rate-limit failures retryable with safe replay guidance', () => {
    const result = toUserSafeError({ status: 429, message: 'gateway response details' })

    expect(result.code).toBe('NETWORK_UNAVAILABLE')
    expect(result.retryable).toBe(true)
    expect(result.remediation).toContain('check its status')
    expect(result.message).not.toContain('gateway response')
  })

  it('provides a stable fallback for unrecognized failures', () => {
    const result = toUserSafeError(new Error('private provider response'), 'support-2')

    expect(result.code).toBe('UNEXPECTED_ERROR')
    expect(result.retryable).toBe(true)
    expect(result.correlationId).toBe('support-2')
    expect(result.remediation).toContain('Check the operation status')
    expect(result.message).not.toContain('private provider response')
  })

  it('documents remediation and retry policy for every stable code', () => {
    for (const guidance of Object.values(USER_SAFE_ERROR_CATALOG)) {
      expect(guidance.message).not.toHaveLength(0)
      expect(guidance.remediation).not.toHaveLength(0)
      expect(typeof guidance.retryable).toBe('boolean')
    }
  })
})
