export type ProviderName = 'smtp' | 'resend' | 'mailpit';

export interface OutboundMessage {
  gatewayMessageId: string;
  keyName: string;
  /** RFC 5322 Message-ID we generate, e.g. <uuid@domain> */
  headerMessageId: string;
  from: { address: string; name?: string | null };
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string | null;
  subject: string;
  text?: string | null;
  html?: string | null;
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
  headers: Record<string, string>;
}

export interface SendOutcome {
  providerMessageId: string;
  response: string;
}

export interface ErrorClassification {
  /** true → retry with backoff; false → permanent failure */
  transient: boolean;
  /** true → counts toward the consecutive-failure circuit breaker (transport/systemic error) */
  systemic: boolean;
  message: string;
}

export interface DeliveryProvider {
  readonly name: ProviderName;
  send(msg: OutboundMessage): Promise<SendOutcome>;
  classify(err: unknown): ErrorClassification;
  close(): Promise<void>;
}

export function gatewayHeaders(keyName: string, messageId: string): Record<string, string> {
  return { 'X-Mail-Gateway-Key': keyName, 'X-Mail-Gateway-Message-Id': messageId };
}
