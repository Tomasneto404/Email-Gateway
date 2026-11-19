// Authored by Tomás Neto (TN 2026)
import { Injectable } from '@nestjs/common';
import { Actor, AdminAuditService } from '../admin/admin-audit.service';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ApiKey, Template } from '../generated/prisma/client';
import { validateDto } from '../keys/keys.service';
import { renderTemplate, templateVariables } from './template-engine';
import { CreateTemplateDto, TemplateDto, UpdateTemplateDto } from './templates.dto';

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  private async view(t: Template, usedBy?: string[]): Promise<TemplateDto> {
    const users =
      usedBy ??
      (await this.prisma.apiKey.findMany({ where: { deletedAt: null, allowedTemplates: { has: t.name } }, select: { name: true }, orderBy: { name: 'asc' } })).map((k) => k.name);
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      subject: t.subject,
      text: t.text,
      html: t.html,
      variables: t.variables,
      usedBy: users,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  async list() {
    const [items, keys] = await Promise.all([
      this.prisma.template.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.apiKey.findMany({ where: { deletedAt: null, NOT: { allowedTemplates: { isEmpty: true } } }, select: { name: true, allowedTemplates: true } }),
    ]);
    const views = await Promise.all(items.map((t) => this.view(t, keys.filter((k) => k.allowedTemplates.includes(t.name)).map((k) => k.name).sort())));
    return { items: views, total: items.length };
  }

  async get(id: string): Promise<Template> {
    const t = isUuid(id) ? await this.prisma.template.findUnique({ where: { id } }) : null;
    if (!t) throw new GatewayError('TEMPLATE_NOT_FOUND', `Template ${id} not found.`);
    return t;
  }

  async getView(id: string) {
    return this.view(await this.get(id));
  }

  async create(body: unknown, actor: Actor) {
    const dto = await validateDto(CreateTemplateDto, body);
    if (!dto.subject) throw new GatewayError('VALIDATION_FAILED', 'subject is required.');
    if (!dto.text && !dto.html) throw new GatewayError('VALIDATION_FAILED', 'Provide a body: text and/or html.');
    if (await this.prisma.template.findUnique({ where: { name: dto.name } })) throw new GatewayError('CONFLICT', `A template named "${dto.name}" already exists.`);
    const src = { subject: dto.subject, text: dto.text ?? null, html: dto.html ?? null };
    const t = await this.prisma.template.create({ data: { name: dto.name, description: dto.description ?? '', ...src, variables: templateVariables(src) } });
    await this.audit.record(actor, { action: 'template.create', targetType: 'template', targetId: t.id, details: { name: t.name, variables: t.variables } });
    return this.view(t, []);
  }

  async update(id: string, body: unknown, actor: Actor) {
    const dto = await validateDto(UpdateTemplateDto, body);
    const before = await this.get(id);
    const next = {
      name: dto.name ?? before.name,
      description: dto.description ?? before.description,
      subject: dto.subject ?? before.subject,
      text: dto.text !== undefined ? dto.text : before.text,
      html: dto.html !== undefined ? dto.html : before.html,
    };
    if (!next.text && !next.html) throw new GatewayError('VALIDATION_FAILED', 'A template needs a body: text and/or html.');
    if (next.name !== before.name && (await this.prisma.template.findUnique({ where: { name: next.name } }))) {
      throw new GatewayError('CONFLICT', `A template named "${next.name}" already exists.`);
    }
    const t = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.template.update({ where: { id }, data: { ...next, variables: templateVariables(next) } });
      if (next.name !== before.name) {
        await tx.$executeRaw`UPDATE api_keys SET allowed_templates = array_replace(allowed_templates, ${before.name}, ${next.name}) WHERE ${before.name} = ANY(allowed_templates)`;
      }
      return updated;
    });
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => next[k] !== before[k]);
    await this.audit.record(actor, { action: 'template.update', targetType: 'template', targetId: id, details: { name: t.name, changed } });
    return this.view(t);
  }

  async remove(id: string, actor: Actor) {
    const t = await this.get(id);
    const users = await this.prisma.apiKey.findMany({ where: { deletedAt: null, allowedTemplates: { has: t.name } }, select: { name: true } });
    if (users.length) {
      throw new GatewayError('CONFLICT', `Template "${t.name}" is allowed by key(s) ${users.map((u) => u.name).join(', ')}. Remove it from their policy first.`);
    }
    await this.prisma.template.delete({ where: { id } });
    await this.audit.record(actor, { action: 'template.delete', targetType: 'template', targetId: id, details: { name: t.name } });
  }

  async preview(id: string, variables: unknown) {
    return renderTemplate(await this.get(id), variables);
  }

  /** Templates a key may use (all of them when its allow-list is empty). */
  async forKey(key: Pick<ApiKey, 'allowedTemplates'>) {
    const where = key.allowedTemplates.length ? { name: { in: key.allowedTemplates } } : {};
    const items = await this.prisma.template.findMany({ where, orderBy: { name: 'asc' } });
    return items.map((t) => ({ name: t.name, description: t.description, variables: t.variables, subject: t.subject }));
  }

  /** Resolves a template for a send: exists and allowed by the key. */
  async forSend(key: Pick<ApiKey, 'name' | 'allowedTemplates'>, name: string): Promise<Template> {
    if (key.allowedTemplates.length && !key.allowedTemplates.includes(name)) {
      throw new GatewayError('TEMPLATE_NOT_ALLOWED', `Template "${name}" is not allowed for key "${key.name}". Allowed: ${key.allowedTemplates.join(', ')}. Call GET /v1/templates.`, {
        allowedTemplates: key.allowedTemplates,
      });
    }
    const t = await this.prisma.template.findUnique({ where: { name } });
    if (!t) throw new GatewayError('TEMPLATE_NOT_FOUND', `Template "${name}" does not exist. Call GET /v1/templates to list the templates you can use.`);
    return t;
  }
}
