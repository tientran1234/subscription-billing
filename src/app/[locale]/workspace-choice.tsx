import { getTranslations } from "next-intl/server";
import type { Principal } from "@/domain/membership";
import { workspacesFor } from "@/server/workspaces";
import { WorkspacePicker } from "./workspace-picker";

/**
 * The picker, with its words and its rows read on the server.
 *
 * A server component between the pages and the client one so that both pages
 * draw the choice from one place. Its messages are a section of their own
 * rather than a copy under `account` and another under `admin`: the same
 * question is being asked on both screens, and two copies of it would be the
 * one that goes stale the day either is edited.
 *
 * Nothing when there is nothing to choose between. An account with one
 * workspace is not making a decision, and a list of one would be a control
 * that does nothing on the page of every customer who has never been invited
 * anywhere.
 */
export async function WorkspaceChoice({
  principal,
  current,
}: {
  principal: Principal;
  /** The workspace this request resolved to, or null where it could not. */
  current: string | null;
}) {
  if (principal.memberships.length < 2) return null;
  const t = await getTranslations("workspace");
  const workspaces = await workspacesFor(principal);

  return (
    <WorkspacePicker
      workspaces={workspaces.map((workspace) => ({
        tenantId: workspace.tenantId,
        name: workspace.name,
        role: workspace.role,
        isCurrent: workspace.tenantId === current,
      }))}
      labels={{
        heading: t("heading"),
        ask: t("ask"),
        showing: t("showing"),
        open: t("open"),
        opening: t("opening"),
        current: t("current"),
        failed: t("failed"),
        // Written out rather than folded over the roles, so adding one to
        // src/domain/role.ts is a compile error here instead of a blank cell.
        roles: {
          admin: t("roleAdmin"),
          member: t("roleMember"),
        },
      }}
    />
  );
}
