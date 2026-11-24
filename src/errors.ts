/**
 * Thrown synchronously when the transport is constructed with unusable options
 * (for example neither `url` nor `agent`). Runtime failures never throw; they
 * are delivered as `error` chunks so `useChat` can show them in `error`.
 */
export class AgUiTransportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgUiTransportConfigError';
  }
}
