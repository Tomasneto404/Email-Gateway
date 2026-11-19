// Authored by Tomás Neto (TN 2026)
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard, AdminRequest, RequirePermission } from '../admin/admin-auth.guard';
import { CreateTemplateDto, TemplateDto, TemplateListDto, TemplatePreviewBody, TemplateRenderDto, UpdateTemplateDto } from './templates.dto';
import { TemplatesService } from './templates.service';

@ApiTags('admin')
@ApiBearerAuth('admin')
@ApiCookieAuth('session')
@UseGuards(AdminAuthGuard)
@Controller('admin/templates')
export class AdminTemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequirePermission('templates:read')
  @ApiOperation({ operationId: 'adminListTemplates' })
  @ApiOkResponse({ type: TemplateListDto })
  list() {
    return this.templates.list();
  }

  @Get(':id')
  @RequirePermission('templates:read')
  @ApiOperation({ operationId: 'adminGetTemplate' })
  @ApiOkResponse({ type: TemplateDto })
  get(@Param('id') id: string) {
    return this.templates.getView(id);
  }

  @Post()
  @RequirePermission('templates:manage')
  @ApiOperation({ operationId: 'adminCreateTemplate', summary: 'Create a template. Variables are written {{name}}.' })
  @ApiBody({ type: CreateTemplateDto })
  @ApiCreatedResponse({ type: TemplateDto })
  create(@Req() req: AdminRequest, @Body() body: unknown) {
    return this.templates.create(body, req.actor);
  }

  @Patch(':id')
  @RequirePermission('templates:manage')
  @ApiOperation({ operationId: 'adminUpdateTemplate' })
  @ApiBody({ type: UpdateTemplateDto })
  @ApiOkResponse({ type: TemplateDto })
  update(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.templates.update(id, body, req.actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('templates:manage')
  @ApiOperation({ operationId: 'adminDeleteTemplate', summary: 'Delete a template no key allows any more.' })
  async remove(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.templates.remove(id, req.actor);
  }

  @Post(':id/preview')
  @HttpCode(200)
  @RequirePermission('templates:read')
  @ApiOperation({ operationId: 'adminPreviewTemplate', summary: 'Render with sample variables (nothing is sent).' })
  @ApiBody({ type: TemplatePreviewBody })
  @ApiOkResponse({ type: TemplateRenderDto })
  preview(@Param('id') id: string, @Body() body: TemplatePreviewBody) {
    return this.templates.preview(id, body?.variables ?? {});
  }
}
