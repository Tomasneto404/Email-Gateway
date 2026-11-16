import { useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** When set, the user must type this exact text (e.g. the key name) to enable the confirm button. */
  typeToConfirm?: string;
  /** Optional free-text reason (e.g. reject reason, pause reason). */
  reasonLabel?: string;
  onConfirm: (reason: string) => void | Promise<void>;
  children?: ReactNode;
}

/** Confirmation for destructive actions; optionally requires typing the target name. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', destructive, typeToConfirm, reasonLabel, onConfirm, children }: Props) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = !typeToConfirm || typed === typeToConfirm;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setTyped('');
          setReason('');
        }
        onOpenChange(o);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription asChild><div className="text-muted-foreground text-sm">{description}</div></AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        {reasonLabel && (
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="confirm-reason">
              {reasonLabel}
            </label>
            <Textarea id="confirm-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
        )}
        {typeToConfirm && (
          <div className="grid gap-1.5">
            <label className="text-sm" htmlFor="confirm-type">
              Type <span className="bg-muted rounded px-1 font-mono font-medium">{typeToConfirm}</span> to confirm
            </label>
            <Input id="confirm-type" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!ok || busy}
            className={cn(destructive && buttonVariants({ variant: 'destructive' }))}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await onConfirm(reason);
                onOpenChange(false);
                setTyped('');
                setReason('');
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
