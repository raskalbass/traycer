import { createContext, use, useContext } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import {
  selectHostIndicatorState,
  useHostNotificationIndicatorState,
  type NotificationIndicatorState,
  type SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";

const EMPTY_INDICATORS: SurfaceNotificationIndicators = {
  epics: {},
  chats: {},
};

export const NotificationIndicatorsContext =
  createContext<SurfaceNotificationIndicators>(EMPTY_INDICATORS);

export const NotificationIndicatorStoreContext =
  createContext<StoreApi<SurfaceNotificationIndicators> | null>(null);

const emptySubscribe = () => () => undefined;

export function useSurfaceNotificationIndicatorState(
  entity: HostNotificationsEntityRef,
  originHostId: string | null,
): NotificationIndicatorState {
  const store = useContext(NotificationIndicatorStoreContext);
  // Direct aggregate providers remain supported; normal surfaces use the
  // stable store context and never consume the broadcasting aggregate.
  const inherited =
    store === null ? use(NotificationIndicatorsContext) : EMPTY_INDICATORS;
  const hostState = useStoreWithEqualityFn(
    store ?? {
      getState: () => inherited,
      getInitialState: () => inherited,
      subscribe: emptySubscribe,
    },
    (indicators) => selectHostIndicatorState(indicators, entity, originHostId),
    shallow,
  );
  return useHostNotificationIndicatorState(entity, originHostId, hostState);
}
