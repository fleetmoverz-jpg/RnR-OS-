import { Share2 } from "lucide-react";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata = { title: "Social Media Automation" };

export default function Page() {
  return (
    <ComingSoon
      icon={Share2}
      title="Social Media Automation"
      phase="Phase 2"
      intro="Connect your social accounts, set a niche and service area, and let RnR Os write posts with AI images and publish them on schedule."
      features={["Connect social accounts", "AI-written posts for your niche and area", "AI-generated images", "Automatic scheduled publishing", "Publishing history and results"]}
    />
  );
}
