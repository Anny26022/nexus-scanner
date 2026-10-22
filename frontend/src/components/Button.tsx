import type { ComponentProps } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

/** Shared text button. Contextual sizing lives in feature CSS (e.g. `.results-actions .button`). */
export function Button({
  variant,
  type = 'button',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant }) {
  const classes = ['button', variant && `button-${variant}`, className].filter(Boolean).join(' ');
  return <button type={type} className={classes} {...props} />;
}
