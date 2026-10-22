import { Database } from "lucide-react";
import { ButtonLink, Card, EmptyState } from "@/components/ui";

export const metadata = { title: "Set up Social Automation" };

// Social pages send you here when the database doesn't have the Social tables yet.
export default function SocialSetupPage() {
  return (
    <Card>
      <EmptyState icon={Database} title="Social Automation needs its database tables" action={<ButtonLink href="/social" variant="primary">I&apos;ve run it, try again</ButtonLink>}>
        Open the Supabase SQL editor, paste the whole of supabase/migrations/0003_social.sql and run it.
      </EmptyState>
    </Card>
  );
}
