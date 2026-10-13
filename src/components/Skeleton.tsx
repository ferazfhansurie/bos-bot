import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("rounded-lg bg-ink/5 motion-safe:animate-pulse", className)} />;
}

/** Keep the destination visible without exposing the previous thread's composer. */
export function ConversationSkeleton({ title }: { title?: string }) {
  return <main role="status" aria-label="Loading conversation" aria-busy="true" className="flex h-full min-w-0 flex-1 flex-col bg-app">
    <header className="flex h-16 shrink-0 items-center justify-center border-b border-hairline px-6">
      {title ? <span className="truncate text-sm text-ink-secondary">{title}</span> : <Skeleton className="h-6 w-40 rounded-full" />}
    </header>
    <div aria-hidden="true" className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-9 overflow-hidden px-8 py-12">
      <Skeleton className="ml-auto h-16 w-2/3 rounded-2xl" />
      <div className="space-y-3"><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/5" /></div>
      <Skeleton className="ml-auto h-12 w-1/2 rounded-2xl" />
      <div className="space-y-3"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-2/3" /></div>
    </div>
    <div className="mx-auto w-full max-w-3xl px-6 pb-6"><Skeleton className="h-24 w-full rounded-3xl" /></div>
    <span className="sr-only">loading conversation</span>
  </main>;
}
