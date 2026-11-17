import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { KeyPolicy, UpdateKey } from '@/api/queries';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { Field, Callout } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { fmtBytes } from '@/lib/format';
import { policySchema, type PolicyForm } from '@/lib/schemas';
import { RecipientChipsInput } from './recipient-chips';
import { Segmented } from './segmented';

export function toForm(k: KeyPolicy): PolicyForm {
  return {
    description: k.description,
    mode: k.mode,
    fromAddress: k.fromAddress,
    fromName: k.fromName ?? '',
    allowReplyTo: k.allowReplyTo,
    allowedRecipients: k.allowedRecipients,
    maxRecipientsPerMessage: k.maxRecipientsPerMessage,
    maxMessageBytes: k.maxMessageBytes,
    quotaPerHour: k.quotaPerHour,
    quotaPerDay: k.quotaPerDay,
    attachmentsAllowed: k.attachmentsAllowed,
    maxAttachmentBytes: k.maxAttachmentBytes,
    liveProvider: k.liveProvider ?? 'default',
  };
}

/** Only the fields that changed, in API shape. */
export function diffPolicy(before: PolicyForm, after: PolicyForm): UpdateKey {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(after) as Array<keyof PolicyForm>) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    if (k === 'liveProvider') patch.liveProvider = after.liveProvider === 'default' ? null : after.liveProvider;
    else if (k === 'fromName') patch.fromName = after.fromName || null;
    else patch[k] = after[k];
  }
  return patch as UpdateKey;
}


const MODE_HINT: Record<PolicyForm['mode'], string> = {
  sandbox: 'Captured by Mailpit, never reaches real recipients',
  approval: 'Held until an administrator approves, then delivered live',
  live: 'Delivered to real recipients through the live provider',
};

/** Titled form section: a two-column grid (one column when `single`). */
function Section({ title, children, single }: { title: string; children: React.ReactNode; single?: boolean }) {
  return (
    <section className="grid gap-4">
      <h3 className="text-secondary-foreground border-b pb-2 text-sm font-medium">{title}</h3>
      <div className={single ? 'grid gap-2' : 'grid items-start gap-x-6 gap-y-4 sm:grid-cols-2'}>{children}</div>
    </section>
  );
}

function ToggleCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <label className="relative flex h-full min-h-16 items-center justify-between gap-4 rounded-lg border px-4 py-3">
      <span className="grid gap-0.5">
        <span className="text-sm leading-5 font-medium">{title}</span>
        <span className="text-muted-foreground text-xs leading-4">{description}</span>
      </span>
      {children}
    </label>
  );
}

interface Props {
  policy: KeyPolicy;
  readOnly?: boolean;
  /** keys:update — edit everything except leaving sandbox (default true) */
  canUpdate?: boolean;
  /** keys:promote — switch mode to live/approval (default true) */
  canPromote?: boolean;
  onSave: (patch: UpdateKey) => Promise<unknown>;
  providers?: { smtp: boolean; resend: boolean };
}

const num = { setValueAs: (v: string) => (v === '' ? undefined : Number(v)) };

export function PolicyEditor({ policy, readOnly, onSave, providers, canUpdate = true, canPromote = true }: Props) {
  const initial = toForm(policy);
  const form = useForm<PolicyForm>({ resolver: zodResolver(policySchema), defaultValues: initial, mode: 'onBlur' });
  const { register, control, handleSubmit, watch, reset, formState } = form;
  const [pending, setPending] = useState<UpdateKey | null>(null);

  useEffect(() => reset(toForm(policy)), [policy, reset]);

  const mode = watch('mode');
  const promoting = mode === 'live' && policy.mode !== 'live';
  const e = formState.errors;

  const submit = handleSubmit(async (values) => {
    const patch = diffPolicy(toForm(policy), values);
    if (!Object.keys(patch).length) return;
    if (patch.mode === 'live') setPending(patch);
    else await onSave(patch);
  });

  return (
    <form onSubmit={submit} className="grid gap-8" aria-label="Policy editor">
      <fieldset disabled={readOnly} className="grid gap-8">
        {!readOnly && (!canUpdate || !canPromote) && (
          <p className="text-muted-foreground -mb-4 text-xs">
            {!canUpdate ? 'Your roles only allow changing the delivery mode.' : 'Your roles do not allow promoting this key out of sandbox (keys:promote).'}
          </p>
        )}
        <Section title="Delivery">
          <Field label="Mode" hint={MODE_HINT[mode]}>
            <Controller
              control={control}
              name="mode"
              render={({ field }) => (
                <Segmented
                  label="Mode"
                  value={field.value}
                  onChange={field.onChange}
                  disabled={readOnly}
                  options={[
                    { value: 'sandbox', label: 'Sandbox', disabled: !canUpdate },
                    { value: 'approval', label: 'Approval', disabled: !canPromote },
                    { value: 'live', label: 'Live', disabled: !canPromote },
                  ]}
                />
              )}
            />
          </Field>
          <Field label="Live provider" hint="Delivers live and approved messages for this key">
            <Controller
              control={control}
              name="liveProvider"
              render={({ field }) => (
                <Segmented
                  label="Live provider"
                  value={field.value}
                  onChange={field.onChange}
                  disabled={readOnly || !canUpdate}
                  options={[
                    { value: 'default', label: 'Default' },
                    { value: 'smtp', label: `SMTP${providers && !providers.smtp ? ' (off)' : ''}` },
                    { value: 'resend', label: `Resend${providers && !providers.resend ? ' (off)' : ''}` },
                  ]}
                />
              )}
            />
          </Field>
          {promoting && (
            <Callout role="alert" tone="warn" icon={<AlertTriangle />} className="sm:col-span-2">
              <div className="font-medium">Promoting to live</div>
              <p className="text-secondary-foreground">
                Every message sent with this key will be delivered to real inboxes using the gateway&apos;s sender reputation. Make sure the allow-list and quotas are tight.
              </p>
            </Callout>
          )}
        </Section>

        <fieldset disabled={readOnly || !canUpdate} className="contents">
        <Section title="Sender">
          <Field label="From address" htmlFor="fromAddress" error={e.fromAddress?.message} hint="Fixed; clients cannot override it">
            <Input id="fromAddress" {...register('fromAddress')} aria-invalid={!!e.fromAddress} />
          </Field>
          <Field label="From name" htmlFor="fromName" error={e.fromName?.message} hint="Optional display name">
            <Input id="fromName" {...register('fromName')} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description" htmlFor="description">
              <Textarea id="description" rows={2} className="min-h-16" {...register('description')} />
            </Field>
          </div>
        </Section>

        <Section title="Allowed recipients" single>
          <Controller
            control={control}
            name="allowedRecipients"
            render={({ field }) => <RecipientChipsInput id="allowedRecipients" value={field.value} onChange={field.onChange} disabled={readOnly || !canUpdate} />}
          />
          <p className="text-muted-foreground text-xs leading-4">Every to/cc/bcc address must match one entry. &quot;@example.com&quot; matches that exact domain only.</p>
        </Section>

        <Section title="Limits">
          <Field label="Quota per hour" htmlFor="quotaPerHour" error={e.quotaPerHour?.message} hint="Messages per UTC hour">
            <Input id="quotaPerHour" type="number" min={0} {...register('quotaPerHour', num)} />
          </Field>
          <Field label="Quota per day" htmlFor="quotaPerDay" error={e.quotaPerDay?.message} hint="Messages per UTC day">
            <Input id="quotaPerDay" type="number" min={0} {...register('quotaPerDay', num)} />
          </Field>
          <Field label="Max recipients per message" htmlFor="maxRecipientsPerMessage" error={e.maxRecipientsPerMessage?.message} hint="to + cc + bcc">
            <Input id="maxRecipientsPerMessage" type="number" min={1} {...register('maxRecipientsPerMessage', num)} />
          </Field>
          <Field label="Max message size (bytes)" htmlFor="maxMessageBytes" error={e.maxMessageBytes?.message} hint={fmtBytes(watch('maxMessageBytes') || 0)}>
            <Input id="maxMessageBytes" type="number" min={1} {...register('maxMessageBytes', num)} />
          </Field>
        </Section>

        <Section title="Options">
          <ToggleCard title="Allow Reply-To" description="Clients may set replyTo">
            <Controller control={control} name="allowReplyTo" render={({ field }) => <Switch aria-label="Allow Reply-To" checked={field.value} onCheckedChange={field.onChange} />} />
          </ToggleCard>
          <ToggleCard title="Allow attachments" description="Base64 attachments up to the size limit">
            <Controller
              control={control}
              name="attachmentsAllowed"
              render={({ field }) => <Switch aria-label="Allow attachments" checked={field.value} onCheckedChange={field.onChange} />}
            />
          </ToggleCard>
          {watch('attachmentsAllowed') && (
            <Field label="Max attachment size (bytes)" htmlFor="maxAttachmentBytes" error={e.maxAttachmentBytes?.message} hint={fmtBytes(watch('maxAttachmentBytes') || 0)}>
              <Input id="maxAttachmentBytes" type="number" min={0} {...register('maxAttachmentBytes', num)} />
            </Field>
          )}
        </Section>
        </fieldset>
      </fieldset>

      {!readOnly && (
        <div className="bg-card sticky bottom-0 -mx-6 -mb-6 flex items-center justify-end gap-2 rounded-b-xl border-t px-6 py-3">
          <Button type="button" variant="ghost" disabled={!formState.isDirty} onClick={() => reset(toForm(policy))}>
            Discard
          </Button>
          <Button type="submit" disabled={!formState.isDirty || formState.isSubmitting}>
            Save policy
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Promote "${policy.name}" to live?`}
        description="Messages will be delivered to real recipients immediately. This is recorded in the activity log."
        confirmLabel="Promote to live"
        destructive
        onConfirm={async () => {
          if (pending) await onSave(pending);
          setPending(null);
        }}
      />
    </form>
  );
}
