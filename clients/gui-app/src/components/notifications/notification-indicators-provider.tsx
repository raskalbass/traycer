import { useLayoutEffect, useState, type ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import {
  NotificationIndicatorsContext,
  NotificationIndicatorStoreContext,
} from "@/components/notifications/notification-indicator-context";
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";

interface NotificationIndicatorsProviderProps {
  readonly indicators: SurfaceNotificationIndicators;
  readonly children: ReactNode;
}

export function NotificationIndicatorsProvider(
  props: NotificationIndicatorsProviderProps,
): ReactNode {
  const [store] = useState(() => createStore(() => props.indicators));
  useLayoutEffect(() => {
    store.setState(props.indicators, true);
  }, [store, props.indicators]);
  return (
    <NotificationIndicatorStoreContext.Provider value={store}>
      <NotificationIndicatorsContext.Provider value={props.indicators}>
        {props.children}
      </NotificationIndicatorsContext.Provider>
    </NotificationIndicatorStoreContext.Provider>
  );
}
