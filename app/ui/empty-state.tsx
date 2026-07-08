// EmptyState — every list's zero state gets the same friendly shape:
// an icon slot, one headline, one sentence, one action. Server-safe.

import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center py-12 px-6">
      {icon && (
        <div aria-hidden="true" className="text-gray-300 [&>svg]:w-12 [&>svg]:h-12">
          {icon}
        </div>
      )}
      <p className="text-base font-semibold text-gray-900">{title}</p>
      {body && <p className="text-sm text-gray-500 max-w-xs">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
