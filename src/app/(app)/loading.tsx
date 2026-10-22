import { Card, Skeleton } from "@/components/ui";

// Shown the moment a sidebar link is clicked, while the page's data loads.
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="space-y-3 p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-3 w-20" />
          </Card>
        ))}
      </div>
      <Card className="space-y-4 p-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-64 w-full" />
      </Card>
      <Card className="space-y-3 p-5">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </Card>
    </div>
  );
}
