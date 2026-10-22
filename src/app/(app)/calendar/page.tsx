import { redirect } from "next/navigation";

// The content calendar now lives in the Social Automation area.
export default function Page() {
  redirect("/social/calendar");
}
