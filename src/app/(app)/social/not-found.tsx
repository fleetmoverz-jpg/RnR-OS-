import { SearchX } from "lucide-react";
import { ButtonLink, Card, EmptyState } from "@/components/ui";

export default function SocialNotFound() {
  return (
    <Card>
      <EmptyState icon={SearchX} title="Not found" action={<ButtonLink href="/social/brands" variant="secondary">Back to brands</ButtonLink>}>
        This doesn&apos;t exist in your workspace, or you don&apos;t have access to it.
      </EmptyState>
    </Card>
  );
}
