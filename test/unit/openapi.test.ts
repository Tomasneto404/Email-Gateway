// Authored by Tomás Neto (TN 2026)
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportOpenApi } from '../../src/openapi.export';

describe('OpenAPI spec', () => {
  it('committed openapi.json matches the code (run `npm run openapi:export` if this fails)', async () => {
    const generated = await exportOpenApi();
    expect(JSON.parse(generated)).toEqual(JSON.parse(readFileSync('openapi.json', 'utf8')));
  });

  it('documents constraints for LLM function-calling', async () => {
    const doc = JSON.parse(await exportOpenApi());
    const send = doc.paths['/v1/send'].post;
    expect(send.operationId).toBe('sendEmail');
    expect(send.description).toMatch(/GET \/v1\/me/);
    expect(Object.keys(send.responses)).toEqual(expect.arrayContaining(['202', '400', '401', '403', '409', '413', '429', '503']));
    expect(send.responses['403'].content['application/json'].schema.$ref).toContain('ErrorResponseDto');
    const to = doc.components.schemas.SendDto.properties.to;
    expect(to.description).toMatch(/allowed by your key's policy/);
    expect(doc.components.schemas.SendDto.required).toEqual(expect.arrayContaining(['to', 'subject']));
    expect(doc.paths['/v1/me'].get.operationId).toBe('getMyPolicy');
    expect(doc.paths['/v1/messages/{id}'].get.operationId).toBe('getMessageStatus');
    // internal endpoints stay out of the public spec
    expect(doc.paths['/webhooks/resend']).toBeUndefined();
    expect(doc.paths['/health/live']).toBeUndefined();
  });
});
