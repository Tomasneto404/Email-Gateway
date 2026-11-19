// Authored by Tomás Neto (TN 2026)
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBase64,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsPlainEmail, NoCrlf } from '../common/validators';

const toLowerArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return value;
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v));
};
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class AttachmentDto {
  @ApiProperty({ description: 'File name shown to the recipient. No line breaks or path separators.', example: 'report.pdf' })
  @IsString() @MinLength(1) @MaxLength(255) @NoCrlf() @Matches(/^[^/\\]+$/, { message: 'filename must not contain path separators' })
  filename!: string;

  @ApiProperty({ description: 'File content, base64-encoded. Decoded size counts toward maxAttachmentBytes and maxMessageBytes.' })
  @IsString() @IsBase64()
  content!: string;

  @ApiPropertyOptional({ description: 'MIME type. Defaults to application/octet-stream.', example: 'application/pdf' })
  @IsOptional() @IsString() @MaxLength(127) @NoCrlf() @Matches(/^[\w.+-]+\/[\w.+-]+$/, { message: 'contentType must look like "type/subtype"' })
  contentType?: string;
}

export class SendDto {
  @ApiProperty({
    description:
      'Recipient address or list of addresses (plain addresses only, e.g. "user@example.com"). Every address must be allowed by your key\'s policy (allowedRecipients); call GET /v1/me to check.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['user@example.com'],
  })
  @Transform(toLowerArray) @IsArray() @ArrayMinSize(1, { message: 'to must contain at least one address' }) @ArrayMaxSize(1000) @IsPlainEmail() @NoCrlf()
  to!: string[];

  @ApiPropertyOptional({ description: 'CC address(es). Same rules as "to"; counts toward maxRecipientsPerMessage.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] })
  @IsOptional() @Transform(toLowerArray) @IsArray() @ArrayMaxSize(1000) @IsPlainEmail() @NoCrlf()
  cc?: string[];

  @ApiPropertyOptional({ description: 'BCC address(es). Same rules as "to"; counts toward maxRecipientsPerMessage.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] })
  @IsOptional() @Transform(toLowerArray) @IsArray() @ArrayMaxSize(1000) @IsPlainEmail() @NoCrlf()
  bcc?: string[];

  @ApiPropertyOptional({ description: 'Subject line, 1-998 characters, no line breaks. Required unless "template" is used.', example: 'Nightly report' })
  @ValidateIf((o: SendDto) => !o.template) @IsString() @MinLength(1, { message: 'subject must not be empty' }) @MaxLength(998) @NoCrlf()
  subject!: string;

  @ApiPropertyOptional({
    description:
      'Name of a server-side template (GET /v1/templates). Renders subject/text/html from "variables"; do not send subject, text or html with it. Keys with templatesOnly=true must use a template.',
    example: 'password-reset',
  })
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9._-]{2,64}$/, { message: 'template must be a template name' })
  template?: string;

  @ApiPropertyOptional({ description: 'Values for the template variables (strings, numbers or booleans). Every variable of the template is required.', type: 'object', additionalProperties: true })
  @IsOptional() @IsObject()
  variables?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Plain-text body. At least one of "text" or "html" is required.' })
  @IsOptional() @IsString()
  text?: string;

  @ApiPropertyOptional({ description: 'HTML body. At least one of "text" or "html" is required. Prefer also sending "text".' })
  @IsOptional() @IsString()
  html?: string;

  @ApiPropertyOptional({ description: 'Reply-To address. Only accepted if your key policy has allowReplyTo=true.' })
  @IsOptional() @Transform(trimLower) @IsPlainEmail() @NoCrlf()
  replyTo?: string;

  @ApiPropertyOptional({ type: [AttachmentDto], description: 'Base64 attachments. Only accepted if your key policy has attachmentsAllowed=true.' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  @ApiPropertyOptional({ description: 'Arbitrary JSON object (max 8 KB) stored with the message for your own correlation. Never sent to recipients.', type: 'object', additionalProperties: true })
  @IsOptional() @IsObject()
  metadata?: Record<string, unknown>;
}

export class SendAcceptedDto {
  @ApiProperty({ description: 'Message id. Use GET /v1/messages/{id} to follow delivery.' }) id!: string;
  @ApiProperty({ enum: ['queued', 'pending_approval'], description: 'queued: will be delivered (sandbox → Mailpit). pending_approval: waiting for an administrator.' })
  status!: string;
}
