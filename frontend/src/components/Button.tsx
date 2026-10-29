import type { ComponentProps } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'compact' | 'icon';

/** Shared button; feature CSS can still adapt sizing for its context. */
export function Button({
  variant,
  size,
  type = 'button',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  const classes = ['button', variant && `button-${variant}`, size && `button-${size}`, className].filter(Boolean).join(' ');
  return <button type={type} className={classes} {...props} />;
}
