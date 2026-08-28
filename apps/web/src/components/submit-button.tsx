'use client';

/**
 * Ported from TaxOS (P76): every form-submitting button in the app renders through this
 * component, so every action the operator triggers has the same three
 * observable states: idle, WORKING (spinner + disabled — the "hourglass"),
 * and done (the page re-renders with the result). Before this, a click on
 * long actions like "Re-run gates" gave no feedback at all: the operator
 * could not tell "still computing" from "finished" from "nothing happened",
 * and a second click mid-run was free.
 *
 * useFormStatus reads the enclosing <form>'s pending state, so this also
 * covers buttons that submit via a formAction override. The button stays
 * type="submit" and passes every other prop through untouched — data-testid,
 * name/value pairs, aria labels — so tests and handlers see the same button.
 */
import { useFormStatus } from 'react-dom';
import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Label shown while the action runs; defaults to "Working…". */
  pendingText?: string;
};

export function SubmitButton({ pendingText, children, disabled, className, ...rest }: Props) {
  const { pending } = useFormStatus();
  return (
    <button
      {...rest}
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending}
      className={`${className ?? ''} disabled:cursor-wait${pending ? ' opacity-60' : ''}`}
    >
      {pending ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          {pendingText ?? 'Working…'}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
