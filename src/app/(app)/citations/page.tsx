import { MapPin } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata = { title: "Citation Builder" };

export default function Page() {
  return (
    <ComingSoon
      icon={MapPin}
      title="Citation Builder"
      phase="Phase 3"
      intro="Find the directories and websites that matter for each business and area, run citation campaigns, and track every listing until it's live."
      features={["Discover citation opportunities by niche and location", "Keep business details (NAP) consistent everywhere", "Organise citations into campaigns", "Track status from submitted to live"]}
    />
  );
}
