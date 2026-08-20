/**
 * Process-wide verifier token accounting.
 *
 * Every verifier backend call records what the provider reported for
 * input / cached-input / output / reasoning tokens, so tool results can show
 * how much verification traffic a session consumed.
 */

export interface TokenUsageSnapshot {
  calls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
}

export interface TokenUsageRecord {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
}

class TokenUsage {
  private calls = 0
  private inputTokens = 0
  private cachedInputTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0

  reset(): void {
    this.calls = 0
    this.inputTokens = 0
    this.cachedInputTokens = 0
    this.outputTokens = 0
    this.reasoningTokens = 0
  }

  add(record: Partial<TokenUsageRecord>, calls = 1): void {
    this.calls += calls
    this.inputTokens += record.inputTokens ?? 0
    this.cachedInputTokens += record.cachedInputTokens ?? 0
    this.outputTokens += record.outputTokens ?? 0
    this.reasoningTokens += record.reasoningTokens ?? 0
  }

  snapshot(): TokenUsageSnapshot {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      cachedInputTokens: this.cachedInputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
    }
  }
}

export const tokenUsage = new TokenUsage()
