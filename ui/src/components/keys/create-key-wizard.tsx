import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { useCreateKey } from '@/api/queries';
import { Field } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { isEmail, isRecipientRule, keyNameSchema } from '@/lib/schemas';
import { RecipientChipsInput } from './recipient-chips';
import { SecretReveal } from './secret-reveal';

const optInt = z.preprocess((v) => (v === '' || v === undefined || Number.isNaN(v) ? undefined : Number(v)), z.number().int().min(0).optional());

const schema = z.object({
  name: keyNameSchema,
  description: z.string().max(500),
  fromAddress: z.string().trim().toLowerCase().refine(isEmail, 'Enter a plain email address'),
  fromName: z.string().max(100).refine((v) => !/[\r\n]/.test(v), 'No line breaks'),
  allowedRecipients: z.array(z.string().refine(isRecipientRule)).min(1, 'Add at least one allowed recipient or domain'),
  quotaPerHour: optInt,
  quotaPerDay: optInt,
});
type Form = z.input<typeof schema>;

const STEPS = ['Basics', 'Recipients & limits', 'Key'];

export function CreateKeyWizard() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [created, setCreated] = useState<{ id: string; name: string; secret: string } | null>(null);
  const create = useCreateKey();
  const navigate = useNavigate();
  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', fromAddress: '', fromName: '', allowedRecipients: [], quotaPerHour: undefined, quotaPerDay: undefined },
  });
  const { register, control, formState, trigger, handleSubmit, reset } = form;
  const e = formState.errors;

  const close = (o: boolean) => {
    setOpen(o);
    if (!o) {
      if (created) navigate({ to: '/keys/$keyId', params: { keyId: created.id } });
      setStep(0);
      setCreated(null);
      reset();
    }
  };

  const submit = handleSubmit(async (v) => {
    const parsed = schema.parse(v);
    const r = await create.mutateAsync({
      name: parsed.name,
      description: parsed.description,
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName || undefined,
      allowedRecipients: parsed.allowedRecipients,
      ...(parsed.quotaPerHour !== undefined ? { quotaPerHour: parsed.quotaPerHour } : {}),
      ...(parsed.quotaPerDay !== undefined ? { quotaPerDay: parsed.quotaPerDay } : {}),
    });
    setCreated({ id: r.key.id, name: r.key.name, secret: r.secret });
    setStep(2);
  });

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> New key
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-lg" onInteractOutside={(ev) => created && ev.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Step {step + 1} of 3 · {STEPS[step]}. New keys always start in <b>sandbox</b> mode.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(ev) => ev.preventDefault()} className="grid gap-4">
            {step === 0 && (
              <>
                <Field label="Name" htmlFor="k-name" error={e.name?.message} hint="Unique. Sent as X-Mail-Gateway-Key.">
                  <Input id="k-name" autoFocus placeholder="report-agent" {...register('name')} />
                </Field>
                <Field label="From address" htmlFor="k-from" error={e.fromAddress?.message}>
                  <Input id="k-from" placeholder="reports@yourcompany.com" {...register('fromAddress')} />
                </Field>
                <Field label="From name" htmlFor="k-fromname" error={e.fromName?.message}>
                  <Input id="k-fromname" placeholder="Optional" {...register('fromName')} />
                </Field>
                <Field label="Description" htmlFor="k-desc">
                  <Textarea id="k-desc" rows={2} {...register('description')} />
                </Field>
              </>
            )}
            {step === 1 && (
              <>
                <Field label="Allowed recipients" error={e.allowedRecipients?.message}>
                  <Controller control={control} name="allowedRecipients" render={({ field }) => <RecipientChipsInput value={field.value} onChange={field.onChange} />} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Quota / hour" htmlFor="k-qh" hint="Blank = gateway default">
                    <Input id="k-qh" type="number" min={0} {...register('quotaPerHour')} />
                  </Field>
                  <Field label="Quota / day" htmlFor="k-qd" hint="Blank = gateway default">
                    <Input id="k-qd" type="number" min={0} {...register('quotaPerDay')} />
                  </Field>
                </div>
              </>
            )}
            {step === 2 && created && <SecretReveal secret={created.secret} name={created.name} />}
          </form>
          <DialogFooter>
            {step === 0 && (
              <Button type="button" onClick={async () => (await trigger(['name', 'fromAddress', 'fromName'])) && setStep(1)}>
                Continue
              </Button>
            )}
            {step === 1 && (
              <>
                <Button type="button" variant="ghost" onClick={() => setStep(0)}>
                  Back
                </Button>
                <Button type="button" disabled={create.isPending} onClick={submit}>
                  Create key
                </Button>
              </>
            )}
            {step === 2 && (
              <Button type="button" onClick={() => close(false)}>
                I&apos;ve stored the key
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
