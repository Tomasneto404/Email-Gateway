// Authored by Tomás Neto (TN 2026)
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsPlainEmail, IsRecipientRule, NoCrlf } from '../common/validators';

const lower = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v)) : value;
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export const KEY_MODES = ['sandbox', 'live', 'approval'] as const;
export const LIVE_PROVIDERS = ['smtp', 'resend'] as const;

export class PolicyFieldsDto {
  @ApiPropertyOptional({ description: 'Free text description of what this key is for.' })
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: KEY_MODES, description: 'sandbox: delivered to Mailpit only. live: delivered for real. approval: held until an admin approves, then delivered live.' })
  @IsOptional() @IsIn(KEY_MODES)
  mode?: (typeof KEY_MODES)[number];

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Fixed sender address (required on create). Clients cannot override it.' })
  @IsOptional() @Transform(trimLower) @IsPlainEmail()
  fromAddress?: string;

  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(100) @NoCrlf()
  fromName?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  allowReplyTo?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Exact addresses ("ops@example.com") and/or domains ("@example.com"). Empty = reject everything.' })
  @IsOptional() @Transform(lower) @IsArray() @ArrayMaxSize(500) @IsRecipientRule()
  allowedRecipients?: string[];

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(1000)
  maxRecipientsPerMessage?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(50 * 1024 * 1024)
  maxMessageBytes?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000)
  quotaPerHour?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10_000_000)
  quotaPerDay?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  attachmentsAllowed?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(40 * 1024 * 1024)
  maxAttachmentBytes?: number;

  @ApiPropertyOptional({ enum: LIVE_PROVIDERS, nullable: true, type: String, description: 'Live provider override; null = gateway default (LIVE_PROVIDER).' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(LIVE_PROVIDERS)
  liveProvider?: (typeof LIVE_PROVIDERS)[number] | null;
}

export class CreateKeyDto extends PolicyFieldsDto {
  @ApiProperty({ description: 'Unique key name (letters, digits, dot, dash, underscore). Added as X-Mail-Gateway-Key header.' })
  @IsString() @MinLength(2) @MaxLength(64) @Matches(/^[A-Za-z0-9._-]+$/, { message: 'name may only contain letters, digits, ".", "_" and "-"' })
  name!: string;
}

export class UpdateKeyDto extends PolicyFieldsDto {}
