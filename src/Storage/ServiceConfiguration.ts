export interface ServiceConfiguration {
  readonly downloadIntervalInSeconds: number,
  readonly downloadRetryDelayInMinutes: number,
  readonly downloadMaxAttempts: number
}
