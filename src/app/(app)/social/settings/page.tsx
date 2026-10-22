import { Briefcase, Gauge, ShieldCheck, Users } from "lucide-react";
import { db } from "@/lib/db";
import { contentService } from "@/lib/social/content/service";
import { contentProviders } from "@/lib/social/content/server";
import { requireWorkspace } from "@/lib/social/workspace";
import { can } from "@/lib/social/policy";
import { isEncryptionKeyValid } from "@/lib/social/crypto";
import { env } from "@/lib/env";
import { Badge, buttonClass, Card, CardHeader, PageHeader, Field, inputClass } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { renameWorkspaceAction, saveAiLimitsAction, switchWorkspaceAction } from "../actions";

export const metadata = { title: "Social Settings" };

export default async function SocialSettingsPage() {
  const { repo, workspaces } = await requireWorkspace();
  const providers = contentProviders();
  const [workspace, members, usage] = await Promise.all([
    repo.getWorkspace(),
    repo.listMembers(),
    contentService(db(), repo.ctx, { text: providers.text, research: providers.research, pricing: providers.pricing }).usage(),
  ]);
  const manage = can(repo.ctx.role, "workspace.manage");
  const keyOk = isEncryptionKeyValid(env.tokenEncryptionKey());
  const keySet = Boolean(env.tokenEncryptionKey());

  return (
    <div className="space-y-6">
      <PageHeader title="Social Settings" description="Workspace, members and security for Social Automation." />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader icon={Briefcase} title="Workspace" description={`Your role: ${repo.ctx.role}`} />
          <div className="space-y-5 p-5">
            {manage ? (
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
        <CardHeader icon={Gauge} title="AI providers and limits" description={`Monthly limits for this workspace. Used in ${usage.month}: ${usage.generations} generations, ${usage.research} research calls, $${usage.costUsd.toFixed(2)}.`} />
        <div className="grid grid-cols-1 gap-6 p-5 lg:grid-cols-2">
          <ul className="space-y-3 text-[13px]">
            <li className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">Writing</p>
                <p className="text-xs text-ink-3">{providers.text ? `${providers.text.id} · ${providers.text.model}` : providers.textReason}</p>
              </div>
              <Badge tone={providers.text ? "success" : "warning"}>{providers.text ? "Ready" : "Off"}</Badge>
            </li>
            <li className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">Research</p>
                <p className="text-xs text-ink-3">{providers.research ? providers.research.id : providers.researchReason}</p>
              </div>
              <Badge tone={providers.research ? "success" : "warning"}>{providers.research ? "Ready" : "Off"}</Badge>
            </li>
            <li>
              <p className="font-medium">Cost estimates</p>
              <p className="text-xs text-ink-3">
                {providers.pricing.inputPerMTok != null && providers.pricing.outputPerMTok != null
                  ? `$${providers.pricing.inputPerMTok} / $${providers.pricing.outputPerMTok} per million input / output tokens.`
                  : "No prices set (AI_PRICE_INPUT_PER_MTOK, AI_PRICE_OUTPUT_PER_MTOK), so costs show as unknown rather than guessed."}
              </p>
            </li>
          </ul>
          {manage ? (
            <ActionForm action={saveAiLimitsAction} submitLabel="Save limits" variant="secondary">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Generations / month"><input name="monthly_generation_limit" type="number" min={0} defaultValue={usage.limits.monthly_generation_limit} className={inputClass} /></Field>
                <Field label="Research / month"><input name="monthly_research_limit" type="number" min={0} defaultValue={usage.limits.monthly_research_limit} className={inputClass} /></Field>
                <Field label="Spend cap (USD)"><input name="monthly_cost_limit_usd" type="number" min={0} step="0.01" defaultValue={usage.limits.monthly_cost_limit_usd} className={inputClass} /></Field>
              </div>
            </ActionForm>
          ) : (
            <p className="text-[13px] text-ink-2">
              Limits: {usage.limits.monthly_generation_limit} generations, {usage.limits.monthly_research_limit} research calls, ${usage.limits.monthly_cost_limit_usd.toFixed(2)} a month.
            </p>
          )}
        </div>
      </Card>

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
