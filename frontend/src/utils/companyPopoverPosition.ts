/** Shared geometry for company panels, anchored to their table symbol. */
export function companyPopoverPosition(trigger: HTMLElement) {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(440, window.innerWidth - 24);
  const height = Math.min(window.innerHeight * 0.78, 680);
  const right = rect.right + 14;
  const left = rect.left - width - 14;
  const placement = window.innerWidth <= 720 ? 'sheet' as const
    : right + width <= window.innerWidth - 12 ? 'right' as const
      : left >= 12 ? 'left' as const : 'right' as const;
  return {
    placement,
    left: placement === 'sheet' ? 12 : placement === 'left' ? left
      : Math.max(12, Math.min(right, window.innerWidth - width - 12)),
    top: placement === 'sheet' ? 0
      : Math.max(12, Math.min(rect.top - 12, window.innerHeight - height - 12)),
  };
}
