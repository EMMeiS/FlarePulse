import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The native element, not a listbox built out of divs: it is keyboard- and
 * screen-reader-correct for free, works inside an uncontrolled form's
 * `FormData`, and is one file instead of a dependency.
 */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Select };
