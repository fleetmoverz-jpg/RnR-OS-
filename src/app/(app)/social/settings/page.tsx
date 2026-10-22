import { Briefcase, ShieldCheck, Users } from "lucide-react";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { isEncryptionKeyValid } from "@/lib/social/crypto";
import { env } from "@/lib/env";
import { Badge, buttonClass, Card, CardHeader, PageHeader, Field, inputClass } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { renameWorkspaceAction, switchWorkspaceAction } from "../actions";

export const metadata = { title: "Social Settings" };

export default async function SocialSettingsPage() {
  const { repo, workspaces } = await requireWorkspace();
  const [workspace, members] = await Promise.all([repo.getWorkspace(), repo.listMembers()]);
  const keyOk = isEncryptionKeyValid(env.tokenEncryptionKey());
  const keySet = Boolean(env.tokenEncryptionKey());

  return (
    <div className="space-y-6">
      <PageHeader title="Social Settings" description="Workspace, members and security for Social Automation." />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader icon={Briefcase} title="Workspace" description={`Your role: ${repo.ctx.role}`} />
          <div className="space-y-5 p-5">
            {can(repo.ctx.role, "workspace.manage") ? (
              <ActionForm action={renameWorkspaceAction} submitLabel="Rename" variant="secondary">
                <Field label="Workspace name"><input name="name" required maxLength={80} defaultValue={workspace.name} className={inputClass} /></Field>
              </ActionForm>
            ) : (
              <p className="text-[13px]">{workspace.name}</p>
            )}
            {workspaces.length > 1 && (
              <div>
                <p className="text-[13px] font-medium">Switch workspace</p>
                <ul className="mt-2 space-y-1.5">
                  {workspaces.map((w) => (
                    <li key={w.id}>
                      <form action={switchWorkspaceAction.bind(null, w.id)}>
                        <button disabled={w.id === workspace.id} className={buttonClass(w.id === workspace.id ? "ghost" : "secondary")}>
                          {w.name} · {w.role}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader icon={ShieldCheck} title="Security" />
          <ul className="divide-y divide-line text-[13px]">
            <li className="flex items-start justify-between gap-3 px-5 py-4">
              <div>
                <p className="font-medium">Token encryption key</p>
                <p className="text-xs text-ink-3">
                  {keyOk
                    ? "Social account tokens will be encrypted with AES-256-GCM before they're stored."
                    : keySet
                      ? "TOKEN_ENCRYPTION_KEY is set but isn't 32 bytes in base64. Generate one with: openssl rand -base64 32"
                      : "Add TOKEN_ENCRYPTION_KEY in Vercel (openssl rand -base64 32). Accounts can't be connected without it."}
                </p>
              </div>
              {keyOk ? <Badge tone="success">Set</Badge> : <Badge tone="warning">{keySet ? "Invalid" : "Missing"}</Badge>}
            </li>
            <li className="flex items-start justify-between gap-3 px-5 py-4">
              <div>
                <p className="font-medium">Workspace isolation</p>
                <p className="text-xs text-ink-3">Every brand, website, account and post belongs to one workspace. The database rejects links across workspaces.</p>
              </div>
              <Badge tone="success">On</Badge>
            </li>
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader icon={Users} title="Members" description="People with access to this workspace. Signing in is limited to the app owner for now." />
        <ul className="divide-y divide-line">
          {members.map((m) => (
            <li key={m.email} className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
              <span className="truncate">{m.email}</span>
              <Badge tone={m.role === "owner" ? "brand" : "neutral"}>{m.role}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
