export interface SessionResumeClaims {
  version: 1;
  sessionId: string;
  userId: string;
  provider: string;
  providerKey: string;
  externalConversationId: string;
  issuedAt: string;
}

export interface ResumeTokenCodec {
  encode(claims: SessionResumeClaims): string;
  decode(token: string): SessionResumeClaims;
}
