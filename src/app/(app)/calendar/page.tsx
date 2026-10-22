import { CalendarDays } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata = { title: "Content Calendar" };

export default function Page() {
  return (
    <ComingSoon
      icon={CalendarDays}
      title="Content Calendar"
      phase="Phase 2"
      intro="See every scheduled and published social post in one calendar, and move posts around with drag and drop."
      features={["Month and week views", "Drag to reschedule", "Status for drafts, scheduled and published posts", "Filter by website and platform"]}
    />
  );
}
