import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Sidebar,
  SidebarList,
  SidebarListItem,
  Text,
  toast,
} from "@glaze/core/components";
import { Plus, FlaskConical } from "lucide-react";

import { api } from "../lib/api";
import { NewRecordingDialog } from "./new-recording-dialog";
import { ImportGitDialog } from "./import-git-dialog";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Native popup menu bridge. The sidebar header action renders as a native
// control, so a React dropdown can't anchor to it — use the native menu popup.
interface MenuPopupItem {
  label?: string;
  type?: "normal" | "separator";
  commandId?: number;
}
interface NativeMenu {
  popup: (options: {
    items: MenuPopupItem[];
    x?: number;
    y?: number;
  }) => Promise<{ commandId?: number }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}

export function LibrarySidebar() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const selectedId = params.id;
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [gitDialogOpen, setGitDialogOpen] = React.useState(false);

  const { data: tests = [] } = useQuery({ queryKey: ["tests"], queryFn: api.tests.list });

  const importFromFiles = async () => {
    try {
      const res = await api.tests.importFiles();
      if (res.imported === 0) return; // user cancelled the picker
      qc.invalidateQueries({ queryKey: ["tests"] });
      toast.success(
        res.imported === 1 ? "Imported 1 test." : `Imported ${res.imported} tests.`,
      );
      if (res.ids[0]) navigate({ to: "/test/$id", params: { id: res.ids[0] } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import tests.");
    }
  };

  const openAddMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      items: [
        { label: "Create New", commandId: 1 },
        { type: "separator" },
        { label: "Select from files", commandId: 2 },
        { label: "From URL", commandId: 3 },
      ],
    });
    if (res.commandId === 1) setDialogOpen(true);
    else if (res.commandId === 2) void importFromFiles();
    else if (res.commandId === 3) setGitDialogOpen(true);
  };

  return (
    <Sidebar
      actions={
        <Button
          iconOnly
          variant="transparent"
          size="small"
          onClick={openAddMenu}
          aria-label="Add test"
        >
          <Plus className="size-4" />
        </Button>
      }
    >
      {tests.length === 0 ? (
        <div className="px-3 py-2">
          <Text variant="small" color="secondary">
            No tests yet. Click + to record, import, or clone your first one.
          </Text>
        </div>
      ) : (
        <SidebarList>
          {tests.map((t) => (
            <SidebarListItem
              key={t.id}
              icon={<FlaskConical className="size-4" />}
              title={t.name}
              subtitle={hostOf(t.url)}
              selected={t.id === selectedId}
              onClick={() => navigate({ to: "/test/$id", params: { id: t.id } })}
            />
          ))}
        </SidebarList>
      )}
      <NewRecordingDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <ImportGitDialog open={gitDialogOpen} onOpenChange={setGitDialogOpen} />
    </Sidebar>
  );
}
