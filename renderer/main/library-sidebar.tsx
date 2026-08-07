import * as React from "react";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
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
  SidebarFooter,
  SidebarList,
  SidebarListItem,
  Slider,
  Status,
  Text,
  toast,
} from "@glaze/core/components";
import { Plus, FlaskConical, FolderOpen, Gauge, EyeOff, BarChart3, Images, ListChecks, Tag, Wand2 } from "lucide-react";

import { api } from "../lib/api";
import type { LlmProvider } from "../lib/llm-types";
import type { TestRecord, TestSpeed } from "../lib/recorder-types";
import { NewRecordingDialog } from "./new-recording-dialog";
import { GenerateTestDialog } from "./generate-test-dialog";
import { ImportGitDialog } from "./import-git-dialog";
import { TagsDialog } from "./tags-dialog";

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

/** A test row's icon: the recorded site's favicon, falling back to the
 * generic FlaskConical icon when the favicon can't be loaded (offline,
 * malformed URL, or a site with no favicon). Uses Google's S2 favicon
 * service so we don't have to fetch/parse `<link rel="icon">` ourselves. */
function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = React.useState(false);
  const host = hostOf(url);
  // 64px source for retina crispness; rendered in a 16px (size-4) box.
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  if (failed) return <FlaskConical className="size-4" />;
  return (
    <img
      src={src}
      alt=""
      width={16}
      height={16}
      className="size-4 shrink-0 object-contain"
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
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
    coordinateSpace?: "screen" | "view";
  }) => Promise<{ commandId?: number }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}

function openSettingsWindow(): void {
  (window as unknown as { glazeAPI: { glaze: { ipc: { invoke: (c: string) => Promise<void> } } } })
    .glazeAPI.glaze.ipc.invoke("window:openSettings")
    .catch(() => {});
}

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  anthropic: "Claude",
};

type ConnState = "checking" | "connected" | "disconnected";

/** Sidebar footer indicator for the configured AI provider. Always visible
 * (for local and cloud providers), showing a green dot when connected, a red
 * dot when not, or a loading dot while probing. Clicking opens Settings on the
 * AI provider section. Re-checks on window focus so a connection just made in
 * Settings is reflected here. */
function AiConnectionFooter() {
  const [state, setState] = React.useState<ConnState>("checking");
  const [label, setLabel] = React.useState<string>("");

  const check = React.useCallback(async () => {
    try {
      const cfg = await api.llm.getConfig();
      const providerName = PROVIDER_LABEL[cfg.provider] ?? cfg.provider;
      setLabel(providerName);
      setState("checking");
      const status = await api.llm.status(cfg.provider);
      if (status.reachable) {
        setState("connected");
      } else {
        setState("disconnected");
        // Use the backend's friendly error as the label tooltip when available.
        if (status.error) setLabel(`${providerName} — ${status.error}`);
      }
    } catch {
      setState("disconnected");
      setLabel("No AI provider");
    }
  }, []);

  React.useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [check]);

  const variant = state === "connected" ? "success" : state === "disconnected" ? "error" : "loading";
  const ariaLabel =
    state === "connected"
      ? `${label} connected`
      : state === "disconnected"
        ? `${label} not connected`
        : `Checking ${label} connection`;

  return (
    <SidebarFooter>
      <button
        type="button"
        onClick={openSettingsWindow}
        title={state === "disconnected" ? label : undefined}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fill-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Status variant={variant} aria-label={ariaLabel} />
        <Text variant="small" color="secondary" className="truncate">
          {state === "connected" ? label : label.split(" — ")[0]}
        </Text>
      </button>
    </SidebarFooter>
  );
}

export function LibrarySidebar() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const selectedId = params.id;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [gitDialogOpen, setGitDialogOpen] = React.useState(false);
  const [tagsFor, setTagsFor] = React.useState<TestRecord | null>(null);

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
      coordinateSpace: "view",
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
      footer={<AiConnectionFooter />}
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
                  icon={<Favicon url={t.url} />}
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
                <CustomContextMenuItem onSelect={() => setTagsFor(t)}>
                  <Tag className="size-4" />
                  Edit Tags…
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
      <div className="mt-auto pt-2">
        <div className="px-2 pb-1 pt-2">
          <Text variant="small" color="secondary" className="font-medium">
            Views
          </Text>
        </div>
        <SidebarList>
          <SidebarListItem
            icon={<BarChart3 className="size-4" />}
            title="Stats"
            subtitle="Run history & logs"
            selected={pathname === "/stats"}
            onClick={() => navigate({ to: "/stats" })}
          />
          <SidebarListItem
            icon={<Images className="size-4" />}
            title="Visual"
            subtitle="Screenshot replay"
            selected={pathname === "/visual"}
            onClick={() => navigate({ to: "/visual" })}
          />
          <SidebarListItem
            icon={<ListChecks className="size-4" />}
            title="Batch"
            subtitle="Run many tests"
            selected={pathname === "/batch"}
            onClick={() => navigate({ to: "/batch" })}
          />
          <SidebarListItem
            icon={<Wand2 className="size-4" />}
            title="Heals"
            subtitle="Locators Auto-Heal changed"
            selected={pathname === "/heals"}
            onClick={() => navigate({ to: "/heals" })}
          />
        </SidebarList>
      </div>
      <NewRecordingDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <GenerateTestDialog open={generateOpen} onOpenChange={setGenerateOpen} />
      <ImportGitDialog open={gitDialogOpen} onOpenChange={setGitDialogOpen} />
      <TagsDialog
        test={tagsFor}
        open={tagsFor !== null}
        onOpenChange={(o) => {
          if (!o) setTagsFor(null);
        }}
      />
    </Sidebar>
  );
}
