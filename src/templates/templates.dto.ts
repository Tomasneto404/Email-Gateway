// Authored by Tomás Neto (TN 2026)
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { NoCrlf } from '../common/validators';

export class TemplateFieldsDto {
  @ApiPropertyOptional({ description: 'What the template is for (shown to API clients in GET /v1/templates).' })
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Subject with {{variables}}. No line breaks.' })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(998) @NoCrlf()
  subject?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Plain-text body with {{variables}}.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1024 * 1024)
  text?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'HTML body with {{variables}} (values are HTML-escaped).' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2 * 1024 * 1024)
  html?: string | null;
}

export class CreateTemplateDto extends TemplateFieldsDto {
  @ApiProperty({ description: 'Unique name used by API clients ("template": "<name>"). Letters, digits, ".", "_", "-".' })
  @IsString() @MinLength(2) @MaxLength(64) @Matches(/^[A-Za-z0-9._-]+$/, { message: 'name may only contain letters, digits, ".", "_" and "-"' })
  name!: string;
}

export class UpdateTemplateDto extends TemplateFieldsDto {
  @ApiPropertyOptional({ description: 'Renaming also updates the keys that allow this template.' })
  @IsOptional() @IsString() @MinLength(2) @MaxLength(64) @Matches(/^[A-Za-z0-9._-]+$/, { message: 'name may only contain letters, digits, ".", "_" and "-"' })
  name?: string;
}

export class TemplateDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty() subject!: string;
  @ApiProperty({ type: String, nullable: true }) text!: string | null;
  @ApiProperty({ type: String, nullable: true }) html!: string | null;
  @ApiProperty({ type: [String], description: 'Variables found in subject/text/html' }) variables!: string[];
  @ApiProperty({ type: [String], description: 'Keys that explicitly allow this template' }) usedBy!: string[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TemplateListDto {
  @ApiProperty({ type: [TemplateDto] }) items!: TemplateDto[];
  @ApiProperty() total!: number;
}

export class TemplatePreviewBody {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Variable values' })
  variables?: Record<string, unknown>;
}

export class TemplateRenderDto {
  @ApiProperty() subject!: string;
  @ApiPropertyOptional() text?: string;
  @ApiPropertyOptional() html?: string;
}

/** What an API client sees: enough to call POST /v1/send with "template" + "variables". */
export class PublicTemplateDto {
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: [String] }) variables!: string[];
  @ApiProperty({ description: 'The subject pattern, with {{variables}}' }) subject!: string;
}
