import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'soft' | 'ghost';
  readonly icon?: ReactNode;
}

/** Pill button. `soft` is the single call-to-action style ("View changes"). */
export const Button = ({ variant = 'soft', icon, children, className, ...rest }: ButtonProps) => (
  <button type="button" className={`btn btn--${variant}${className ? ` ${className}` : ''}`} {...rest}>
    {icon}
    {children}
  </button>
);

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly active?: boolean;
}

/** 28px round icon button with an accessible label. */
export const IconButton = ({ label, active = false, children, className, ...rest }: IconButtonProps) => (
  <button type="button" aria-label={label} title={label} aria-pressed={active || undefined} className={`icon-btn${active ? ' icon-btn--active' : ''}${className ? ` ${className}` : ''}`} {...rest}>
    {children}
  </button>
);
