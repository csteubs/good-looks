import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Sidebar,
  SidebarList,
  SidebarListItem,
  Text,
} from "@glaze/core/components";
import { Plus, FlaskConical } from "lucide-react";

import { api } from "../lib/api";
import { NewRecordingDialog } from "./new-recording-dialog";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function LibrarySidebar() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { id?: string };
  const selectedId = params.id;
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const { data: tests = [] } = useQuery({ queryKey: ["tests"], queryFn: api.tests.list });

  return (
    <Sidebar
      actions={
        <Button
          iconOnly
          variant="transparent"
          size="small"
          onClick={() => setDialogOpen(true)}
          aria-label="New recording"
        >
          <Plus className="size-4" />
        </Button>
      }
    >
      {tests.length === 0 ? (
        <div className="px-3 py-2">
          <Text variant="small" color="secondary">
            No tests yet. Click + to record your first one.
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
    </Sidebar>
  );
}
