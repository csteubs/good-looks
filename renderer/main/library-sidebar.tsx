import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  CustomContextMenu,
  CustomContextMenuContent,
  CustomContextMenuItem,
  CustomContextMenuSeparator,
  CustomContextMenuSub,
  CustomContextMenuSubContent,
  CustomContextMenuSubTrigger,
  CustomContextMenuTrigger,
  Sidebar,
  SidebarList,
  SidebarListItem,
  Slider,
  Text,
  toast,
} from "@glaze/core/components";
import { Plus, FlaskConical, FolderOpen, Gauge, EyeOff } from "lucide-react";

import { api } from "../lib/api";
import type { TestRecord, TestSpeed } from "../lib/recorder-types";
import { NewRecordingDialog } from "./new-recording-dialog";
import { GenerateTestDialog } from "./generate-test-dialog";
import { ImportGitDialog } from "./import-git-dialog";

const SPEEDS: TestSpeed[] = ["slow", "medium", "fast"];
const SPEED_LABEL: Record<TestSpeed, string> = { slow: "Slow", medium: "Medium", fast: "Fast" };

interface NativeShell {
  showItemInFolder: (fullPath: string) => void;
}
function nativeShell(): NativeShell {
  return (window as unknown as { glazeAPI: { shell: NativeShell } }).glazeAPI.shell;
}

/** Slider embedded in the "Adjust Test Speed" submenu — snaps to 3 named speeds
 * rather than an arbitrary ms value, since that's what a Playwright slowMo delay
 * usefully supports. Pointer/keyboard events are stopped from bubbling so Radix's
 * menu roving-focus doesn't hijack the drag. */
function TestSpeedSlider({ test }: { test: TestRecord }) {
  const qc = useQueryClient();
  const initial = Math.max(0, SPEEDS.indexOf(test.speed ?? "fast"));
  const [index, setIndex] = React.useState(initial);
  const lastCommitted = React.useRef(initial);

  // Commit on every discrete step change rather than waiting for
  // onValueCommit (drag-end) — with only 3 stops, a plain click never
  // produces a drag gesture, so onValueCommit would never fire.
  const handleChange = ([v]: number[]) => {
    setIndex(v);
    if (lastCommitted.current === v) return;
    lastCommitted.current = v;
    void (async () => {
      try {
        await api.tests.setSpeed(test.id, SPEEDS[v]);
        qc.invalidateQueries({ queryKey: ["tests"] });
        qc.invalidateQueries({ queryKey: ["test", test.id] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update test speed.");
      }
    })();
  };

  return (
    <div
      className="w-52 px-2 py-2"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <Text variant="small" color="secondary">
          Speed
        </Text>
        <Text variant="small">{SPEED_LABEL[SPEEDS[index]]}</Text>
      </div>
      <Slider
        variant="filled"
        size="small"
        min={0}
        max={2}
        step={1}
        ticks={3}
        value={[index]}
        startContent="Slow"
        endContent="Fast"
        onValueChange={handleChange}
      />
    </div>
  );
}

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
  const [generateOpen, setGenerateOpen] = React.useState(false);
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
        { label: "Train manually", commandId: 1 },
        { label: "Generate from prompt", commandId: 4 },
        { type: "separator" },
        { label: "Select from files", commandId: 2 },
        { label: "From URL", commandId: 3 },
      ],
    });
    if (res.commandId === 1) setDialogOpen(true);
    else if (res.commandId === 4) setGenerateOpen(true);
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
            No tests yet. Click + to train, generate, import, or clone your first one.
          </Text>
        </div>
      ) : (
        <SidebarList>
          {tests.map((t) => (
            <CustomContextMenu key={t.id}>
              <CustomContextMenuTrigger asChild>
                <SidebarListItem
                  icon={<FlaskConical className="size-4" />}
                  title={t.name}
                  subtitle={hostOf(t.url)}
                  selected={t.id === selectedId}
                  onClick={() => navigate({ to: "/test/$id", params: { id: t.id } })}
                />
              </CustomContextMenuTrigger>
              <CustomContextMenuContent>
                <CustomContextMenuItem onSelect={() => nativeShell().showItemInFolder(t.scriptPath)}>
                  <FolderOpen className="size-4" />
                  Reveal in Finder
                </CustomContextMenuItem>
                <CustomContextMenuSeparator />
                <CustomContextMenuItem
                  onSelect={async () => {
                    try {
                      await api.tests.setHidden(t.id, true);
                      qc.invalidateQueries({ queryKey: ["tests"] });
                      if (t.id === selectedId) navigate({ to: "/" });
                      toast.success("Removed from sidebar.");
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Failed to remove test.");
                    }
                  }}
                >
                  <EyeOff className="size-4" />
                  Remove from Sidebar
                </CustomContextMenuItem>
                <CustomContextMenuSeparator />
                <CustomContextMenuSub>
                  <CustomContextMenuSubTrigger value={SPEED_LABEL[t.speed ?? "fast"]}>
                    <Gauge className="size-4" />
                    Adjust Test Speed
                  </CustomContextMenuSubTrigger>
                  <CustomContextMenuSubContent>
                    <TestSpeedSlider test={t} />
                  </CustomContextMenuSubContent>
                </CustomContextMenuSub>
              </CustomContextMenuContent>
            </CustomContextMenu>
          ))}
        </SidebarList>
      )}
      <NewRecordingDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <GenerateTestDialog open={generateOpen} onOpenChange={setGenerateOpen} />
      <ImportGitDialog open={gitDialogOpen} onOpenChange={setGitDialogOpen} />
    </Sidebar>
  );
}
