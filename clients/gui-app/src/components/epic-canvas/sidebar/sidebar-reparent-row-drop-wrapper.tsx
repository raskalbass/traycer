import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  getSidebarReparentRowDropId,
  getPaneScopedDndId,
  type EpicCanvasDropTargetData,
} from "@/components/epic-canvas/dnd/dnd";
import { useSidebarReparentTargetActive } from "@/components/epic-canvas/dnd/dnd-store";
import type { RootCreatePanelId } from "@/stores/epics/left-panel-store";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";

const SidebarContextMenuRowContext = createContext<{
  rowId: string | null;
  clearTarget: (rowId: string) => void;
} | null>(null);

/** One Radix root for the tree; only the targeted row mounts its content. */
export function SidebarTreeContextMenu({
  children,
}: {
  readonly children: ReactElement;
}) {
  const [menu, setMenu] = useState<{
    rowId: string | null;
    target: Element | null;
    open: boolean;
  }>({ rowId: null, target: null, open: false });
  const clearTarget = useCallback((rowId: string) => {
    setMenu((current) =>
      current.rowId === rowId &&
      (!current.target?.isConnected ||
        current.target.getAttribute("data-sidebar-context-menu") !== "enabled")
        ? { rowId: null, target: null, open: false }
        : current,
    );
  }, []);
  const context = useMemo(
    () => ({ rowId: menu.rowId, clearTarget }),
    [menu.rowId, clearTarget],
  );
  const selectRow = (event: SyntheticEvent) => {
    // Portaled menu content follows React ancestry but is not a tree row.
    if (
      !(event.target instanceof Element) ||
      !event.currentTarget.contains(event.target)
    ) {
      return;
    }
    const row = event.target.closest("[data-sidebar-row-id]");
    if (row?.getAttribute("data-sidebar-context-menu") !== "enabled") {
      // Keep native context menus and ordinary clicks on disabled rows. Stop
      // only this gesture from reaching the tree's Radix trigger.
      event.stopPropagation();
      return;
    }
    const rowId = row.getAttribute("data-sidebar-row-id");
    setMenu((current) => ({ ...current, rowId, target: row }));
  };
  return (
    <SidebarContextMenuRowContext.Provider value={context}>
      <ContextMenu
        open={menu.open}
        onOpenChange={(open) => {
          setMenu((current) => ({
            ...current,
            open: open && current.rowId !== null,
          }));
        }}
      >
        <ContextMenuTrigger
          asChild
          onContextMenuCapture={selectRow}
          onContextMenu={ignorePortaledTriggerEvent}
          onPointerDown={(event) => {
            if (event.pointerType !== "mouse")
              ignorePortaledTriggerEvent(event);
          }}
          onPointerDownCapture={(event) => {
            if (event.pointerType !== "mouse") selectRow(event);
          }}
        >
          {children}
        </ContextMenuTrigger>
      </ContextMenu>
    </SidebarContextMenuRowContext.Provider>
  );
}

function SidebarContextMenuTarget({
  rowId,
  clearTarget,
  children,
}: {
  rowId: string;
  clearTarget: (rowId: string) => void;
  children: ReactNode;
}) {
  // Passive cleanup sees the committed DOM removal/eligibility marker.
  // A still-connected, eligible target survives StrictMode's effect replay.
  useEffect(() => () => clearTarget(rowId), [rowId, clearTarget]);
  return children;
}

// Radix composes these trigger handlers with a defaultPrevented check. Skip
// only its trigger behavior; native bubbling must reach DismissableLayer.
function ignorePortaledTriggerEvent(event: SyntheticEvent) {
  if (
    event.target instanceof Node &&
    !event.currentTarget.contains(event.target)
  ) {
    event.preventDefault();
  }
}

/**
 * Row container shared by the chat and artifact trees: registers the
 * `sidebar-reparent-row` drop target on the row wrapper (the draggable stays on
 * the inner row button) and highlights while this row is the active reparent
 * target. Only `panelId` differs between the two trees.
 */
export function SidebarReparentRowDropWrapper(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly nodeId: string;
  readonly panelId: RootCreatePanelId;
  readonly children: ReactNode;
  readonly contextMenu: ReactNode | null;
}) {
  const { epicId, viewTabId, nodeId, panelId, children, contextMenu } = props;
  const dropData = useMemo<EpicCanvasDropTargetData>(
    () => ({
      kind: "sidebar-reparent-row",
      epicId,
      viewTabId,
      nodeId,
      panelId,
    }),
    [epicId, viewTabId, nodeId, panelId],
  );
  const { setNodeRef } = useDroppable({
    id: getPaneScopedDndId(viewTabId, getSidebarReparentRowDropId(nodeId)),
    data: dropData,
  });
  const isReparentTarget = useSidebarReparentTargetActive(viewTabId, nodeId);
  const menu = useContext(SidebarContextMenuRowContext);
  return (
    <div
      ref={setNodeRef}
      data-sidebar-row-id={nodeId}
      data-sidebar-context-menu={contextMenu === null ? "disabled" : "enabled"}
      className={cn(
        "group/tree-item relative flex items-center gap-1 rounded-md",
        isReparentTarget && "bg-accent/60 ring-2 ring-inset ring-primary/70",
      )}
    >
      {children}
      {menu?.rowId === nodeId && contextMenu !== null ? (
        <SidebarContextMenuTarget rowId={nodeId} clearTarget={menu.clearTarget}>
          {contextMenu}
        </SidebarContextMenuTarget>
      ) : null}
    </div>
  );
}
